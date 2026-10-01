import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { from, switchMap, tap, throwError } from 'rxjs';
import { ApiError } from '../api/errors';
import { RUNTIME_CONFIG } from '../config';
import { challengeFor, randomString } from './pkce';

/** Leaves the app for Keycloak; replaced in tests. */
export const REDIRECT = new InjectionToken<(url: string) => void>('REDIRECT', {
  factory: () => (url: string) => window.location.assign(url),
});

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
}

interface PendingLogin {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

const TOKENS = 'daily2.tokens';
const PENDING = 'daily2.login';
const LOGIN_AT = 'daily2.loginAt';
const REFRESH_MARGIN_MS = 30_000;
const LOGIN_LOOP_MS = 30_000;
const DEFAULT_RETURN = '/today';

class TokenEndpointError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

function safeReturnTo(returnTo: string): string {
  const path = returnTo.split(/[?#]/)[0];
  const usable = returnTo.startsWith('/') && !returnTo.startsWith('//');
  const blocked = ['/callback', '/signed-out'].some((p) => path === p || path.startsWith(`${p}/`));
  return usable && !blocked ? returnTo : DEFAULT_RETURN;
}

function idTokenNonce(idToken: string | undefined): unknown {
  try {
    const payload = idToken?.split('.')[1] ?? '';
    const padded = payload.replaceAll('-', '+').replaceAll('_', '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    return (JSON.parse(json) as { nonce?: unknown }).nonce;
  } catch {
    return undefined;
  }
}

function read<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** OIDC authorization code flow with PKCE against Keycloak, with silent refresh. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly config = inject(RUNTIME_CONFIG);
  private readonly redirect = inject(REDIRECT);
  private readonly tokens = signal<Tokens | null>(read<Tokens>(localStorage, TOKENS));
  private readonly router = inject(Router);
  private refreshing: Promise<string | null> | null = null;
  private loginStarted = false;
  private signedOutShown = false;

  constructor() {
    window.addEventListener('storage', (event) => {
      if (event.key === TOKENS || event.key === null) {
        this.tokens.set(read<Tokens>(localStorage, TOKENS));
      }
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        this.loginStarted = false;
      }
    });
  }

  readonly signedIn = computed(() => this.tokens() !== null);

  /** Start a login; the browser comes back to /callback. */
  async login(returnTo: string): Promise<void> {
    this.loginStarted = true;
    this.signedOutShown = false;
    try {
      await this.startLogin(returnTo);
    } catch (error) {
      this.loginStarted = false;
      throw error;
    }
  }

  private async startLogin(returnTo: string): Promise<void> {
    const pending: PendingLogin = {
      verifier: randomString(),
      state: randomString(16),
      nonce: randomString(16),
      returnTo: safeReturnTo(returnTo),
    };
    sessionStorage.setItem(PENDING, JSON.stringify(pending));
    const url = new URL(this.endpoint('auth'));
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      scope: 'openid',
      redirect_uri: this.callbackUrl(),
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await challengeFor(pending.verifier),
      code_challenge_method: 'S256',
    }).toString();
    this.redirect(url.toString());
  }

  /** Finish a login from the callback's query; returns where the user wanted to go. */
  async completeLogin(params: URLSearchParams): Promise<string> {
    const pending = read<PendingLogin>(sessionStorage, PENDING);
    sessionStorage.removeItem(PENDING);
    const error = params.get('error');
    if (error) {
      throw new Error(params.get('error_description') ?? error);
    }
    if (pending && !pending.nonce) {
      throw new Error('The sign-in could not be verified (missing nonce). Please sign in again.');
    }
    const code = params.get('code');
    if (!pending || !code || params.get('state') !== pending.state) {
      throw new Error('The sign-in could not be verified. Please sign in again.');
    }
    await this.exchange(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl(),
        code_verifier: pending.verifier,
      },
      pending.nonce,
    );
    this.loginStarted = false;
    sessionStorage.setItem(LOGIN_AT, String(Date.now()));
    return safeReturnTo(pending.returnTo);
  }

  /**
   * The API refused a token we just sent: sign in again, once. While a login runs later
   * calls do nothing; right after a login the refusal is final and the user sees "signed out".
   */
  async reauthenticate(returnTo: string): Promise<void> {
    if (this.loginStarted || this.signedOutShown) {
      return;
    }
    const loginAt = Number(sessionStorage.getItem(LOGIN_AT));
    if (loginAt && Date.now() - loginAt < LOGIN_LOOP_MS) {
      this.signedOutShown = true;
      this.clear();
      sessionStorage.removeItem(LOGIN_AT);
      await this.router.navigateByUrl('/signed-out');
      return;
    }
    await this.login(returnTo);
  }

  /** A valid access token, refreshed when it is about to expire; null when signed out. */
  async accessToken(): Promise<string | null> {
    const tokens = this.tokens();
    if (!tokens) {
      return null;
    }
    if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      this.clear();
      return null;
    }
    this.refreshing ??= this.exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    })
      .then(
        () => this.tokens()?.accessToken ?? null,
        (error: unknown) => {
          const rejected =
            error instanceof TokenEndpointError && (error.status === 400 || error.status === 401);
          if (rejected) {
            const stored = read<Tokens>(localStorage, TOKENS);
            if (stored && stored.refreshToken !== tokens.refreshToken) {
              this.tokens.set(stored);
              return stored.accessToken;
            }
            this.clear();
          }
          return null;
        },
      )
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Forget the tokens and end the Keycloak session. */
  logout(): void {
    const idToken = this.tokens()?.idToken;
    this.clear();
    const url = new URL(this.endpoint('logout'));
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      post_logout_redirect_uri: `${window.location.origin}/`,
      ...(idToken ? { id_token_hint: idToken } : {}),
    }).toString();
    this.redirect(url.toString());
  }

  private endpoint(name: 'auth' | 'token' | 'logout'): string {
    const { keycloakUrl, realm } = this.config;
    return `${keycloakUrl}/realms/${realm}/protocol/openid-connect/${name}`;
  }

  private callbackUrl(): string {
    return `${window.location.origin}/callback`;
  }

  private async exchange(body: Record<string, string>, nonce?: string): Promise<void> {
    const response = await fetch(this.endpoint('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, ...body }),
    });
    if (!response.ok) {
      throw new TokenEndpointError(
        `Keycloak refused the sign-in (HTTP ${response.status}).`,
        response.status,
      );
    }
    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in: number;
    };
    if (typeof data.access_token !== 'string' || data.access_token === '') {
      throw new TokenEndpointError('Keycloak sent an invalid access token.', null);
    }
    if (
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw new TokenEndpointError('Keycloak sent an invalid token lifetime.', null);
    }
    if (nonce !== undefined && idTokenNonce(data.id_token) !== nonce) {
      throw new TokenEndpointError(
        'The sign-in could not be verified (nonce mismatch). Please sign in again.',
        null,
      );
    }
    const previous = this.tokens();
    const tokens: Tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? previous?.refreshToken ?? null,
      idToken: data.id_token ?? previous?.idToken ?? null,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    localStorage.setItem(TOKENS, JSON.stringify(tokens));
    this.tokens.set(tokens);
  }

  private clear(): void {
    localStorage.removeItem(TOKENS);
    this.tokens.set(null);
  }
}

function isApiRequest(url: string, apiBase: string): boolean {
  try {
    const resolved = new URL(url, window.location.origin);
    return (
      resolved.origin === window.location.origin &&
      (resolved.pathname === apiBase || resolved.pathname.startsWith(`${apiBase}/`))
    );
  } catch {
    return false;
  }
}

/** Adds the bearer token to same-origin API requests; a 401 starts one new login. */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(Auth);
  const router = inject(Router);
  if (!isApiRequest(request.url, inject(RUNTIME_CONFIG).apiBase)) {
    return next(request);
  }
  return from(auth.accessToken()).pipe(
    switchMap((token) => {
      if (!token && auth.signedIn()) {
        return throwError(
          () => new ApiError('offline', 'The session could not be refreshed.', null, 0),
        );
      }
      return next(
        token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request,
      );
    }),
    tap({
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse && error.status === 401) {
          void auth.reauthenticate(router.url);
        }
      },
    }),
  );
};

/** Lets a route open only when signed in; otherwise starts the login. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  if ((await auth.accessToken()) || auth.signedIn()) {
    return true;
  }
  await auth.login(state.url);
  return false;
};
