import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TEST_CONFIG, provideTestConfig } from '../../../testing/config';
import { Auth, REDIRECT, authGuard, authInterceptor } from './auth';
import { challengeFor } from './pkce';

function idToken(nonce: string | null): string {
  const payload = btoa(JSON.stringify({ nonce })).replaceAll('+', '-').replaceAll('/', '_');
  return `h.${payload.replace(/=+$/, '')}.s`;
}

function tokenResponse(expiresIn: unknown = 300, access = 'access-1', id: string | null = 'id-1') {
  return new Response(
    JSON.stringify({
      access_token: access,
      ...(id ? { refresh_token: 'refresh-1', id_token: id } : {}),
      expires_in: expiresIn,
    }),
    { status: 200 },
  );
}

describe('Auth', () => {
  let redirect: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    redirect = vi.fn();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    TestBed.configureTestingModule({
      providers: [
        provideTestConfig(),
        { provide: REDIRECT, useValue: redirect },
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  async function signIn(expiresIn = 300): Promise<Auth> {
    const auth = TestBed.inject(Auth);
    await auth.login('/diary');
    const url = new URL(redirect.mock.calls[0][0] as string);
    fetchSpy.mockResolvedValueOnce(
      tokenResponse(expiresIn, 'access-1', idToken(url.searchParams.get('nonce'))),
    );
    const returnTo = await auth.completeLogin(
      new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state')! }),
    );
    expect(returnTo).toBe('/diary');
    return auth;
  }

  it('redirects to Keycloak with an S256 challenge', async () => {
    await TestBed.inject(Auth).login('/today');
    const url = new URL(redirect.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      'http://kc.test/realms/daily2/protocol/openid-connect/auth',
    );
    expect(url.searchParams.get('client_id')).toBe('daily2-app');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/callback`);
  });

  it('exchanges the code with the verifier and stores the tokens', async () => {
    const auth = await signIn();
    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('http://kc.test/realms/daily2/protocol/openid-connect/token');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.signedIn()).toBe(true);
    await expect(auth.accessToken()).resolves.toBe('access-1');
  });

  it('rejects a callback whose state does not match', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/today');
    await expect(
      auth.completeLogin(new URLSearchParams({ code: 'c', state: 'forged' })),
    ).rejects.toThrow('could not be verified');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes a token that is about to expire', async () => {
    const auth = await signIn(10);
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'access-2'));
    await expect(auth.accessToken()).resolves.toBe('access-2');
    const body = (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('signs out when the refresh fails', async () => {
    const auth = await signIn(10);
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(auth.accessToken()).resolves.toBeNull();
    expect(auth.signedIn()).toBe(false);
  });

  async function apiGet(
    url: string,
    status?: number,
  ): Promise<{ header: string | null; result: unknown }> {
    const http = TestBed.inject(HttpClient);
    const backend = TestBed.inject(HttpTestingController);
    const api = firstValueFrom(http.get(url)).then(
      (value) => value,
      (error: unknown) => error,
    );
    let call!: TestRequest;
    await vi.waitFor(() => {
      const found = backend.match(url);
      if (found.length !== 1) {
        throw new Error(`expected one request to ${url}, saw ${found.length}`);
      }
      call = found[0];
    });
    const header = call.request.headers.get('Authorization');
    if (status) {
      call.flush({ code: 'unauthorized', message: 'x' }, { status, statusText: 'x' });
    } else {
      call.flush({});
    }
    return { header, result: await api };
  }

  it('adds the bearer token to same-origin API calls only', async () => {
    await signIn();
    expect((await apiGet('/api/v2/views/today')).header).toBe('Bearer access-1');
    expect((await apiGet('/api/v2')).header).toBe('Bearer access-1');
    expect((await apiGet('/apiary/x')).header).toBeNull();
    expect((await apiGet('/runtime-config.json')).header).toBeNull();
    expect((await apiGet('http://evil.test/api/v2/x')).header).toBeNull();
    expect((await apiGet(`${window.location.origin}/api/v2/x`)).header).toBe('Bearer access-1');
  });

  it('logs in again on 401 once the last login is old, and only once at a time', async () => {
    await signIn();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    await apiGet('/api/v2/a', 401);
    await vi.waitFor(() => expect(redirect).toHaveBeenCalledTimes(2));
    await apiGet('/api/v2/b', 401);
    await new Promise((resolve) => setTimeout(resolve));
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it('does not loop: a 401 right after a login signs out and shows the signed-out page', async () => {
    const auth = await signIn();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { result } = await apiGet('/api/v2/a', 401);
    expect(result).toBeTruthy();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/signed-out'));
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(auth.signedIn()).toBe(false);
    expect(localStorage.getItem('daily2.tokens')).toBeNull();
  });

  it('shows the signed-out page once: concurrent 401s right after a login are no-ops', async () => {
    await signIn();
    redirect.mockClear();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const http = TestBed.inject(HttpClient);
    const backend = TestBed.inject(HttpTestingController);
    const calls = ['/api/v2/a', '/api/v2/b'].map((url) =>
      firstValueFrom(http.get(url)).catch((e: unknown) => e),
    );
    const pending: TestRequest[] = [];
    await vi.waitFor(() => {
      pending.push(...backend.match(() => true));
      expect(pending).toHaveLength(2);
    });
    for (const call of pending) {
      call.flush({ code: 'unauthorized', message: 'x' }, { status: 401, statusText: 'x' });
    }
    await Promise.all(calls);
    await new Promise((resolve) => setTimeout(resolve));
    expect(redirect).toHaveBeenCalledTimes(0);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/signed-out');
  });

  it('fails the login when the pending entry has no nonce', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/today');
    const url = new URL(redirect.mock.calls[0][0] as string);
    const pending = JSON.parse(sessionStorage.getItem('daily2.login')!);
    delete pending.nonce;
    sessionStorage.setItem('daily2.login', JSON.stringify(pending));
    await expect(
      auth.completeLogin(new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! })),
    ).rejects.toThrow('nonce');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auth.signedIn()).toBe(false);
  });

  it('treats an empty access token as a failed refresh without dropping the session', async () => {
    const auth = await signIn(10);
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, ''));
    await expect(auth.accessToken()).resolves.toBeNull();
    expect(auth.signedIn()).toBe(true);
  });

  it('allows a new login after login() threw before redirecting', async () => {
    const auth = TestBed.inject(Auth);
    redirect.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    await expect(auth.login('/today')).rejects.toThrow('blocked');
    await auth.reauthenticate('/today');
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it('adopts newer tokens from another tab when the refresh is rejected', async () => {
    const auth = await signIn(10);
    const other = {
      accessToken: 'other-tab',
      refreshToken: 'r2',
      idToken: null,
      expiresAt: Date.now() + 300_000,
    };
    fetchSpy.mockImplementationOnce(async () => {
      localStorage.setItem('daily2.tokens', JSON.stringify(other));
      return new Response('{}', { status: 400 });
    });
    await expect(auth.accessToken()).resolves.toBe('other-tab');
    expect(auth.signedIn()).toBe(true);
    expect(localStorage.getItem('daily2.tokens')).not.toBeNull();
  });

  it('never uses the signed-out page as the return path', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/signed-out');
    const url = new URL(redirect.mock.calls[0][0] as string);
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'a', idToken(url.searchParams.get('nonce'))));
    const returnTo = await auth.completeLogin(
      new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! }),
    );
    expect(returnTo).toBe('/today');
  });

  it('never uses the callback URL as the return path', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/callback?code=x&state=y');
    const url = new URL(redirect.mock.calls[0][0] as string);
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'a', idToken(url.searchParams.get('nonce'))));
    const returnTo = await auth.completeLogin(
      new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! }),
    );
    expect(returnTo).toBe('/today');
  });

  it('keeps the tokens when the refresh fails transiently', async () => {
    const auth = await signIn(10);
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(auth.accessToken()).resolves.toBeNull();
    expect(auth.signedIn()).toBe(true);
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(auth.accessToken()).resolves.toBeNull();
    expect(auth.signedIn()).toBe(true);
    expect(localStorage.getItem('daily2.tokens')).not.toBeNull();
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'access-2', idToken('ignored')));
    await expect(auth.accessToken()).resolves.toBe('access-2');
  });

  it('fails an API request as offline, not as a login, when the refresh is transient', async () => {
    await signIn(10);
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const http = TestBed.inject(HttpClient);
    const error = await firstValueFrom(http.get('/api/v2/x')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'offline' });
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('treats an invalid expires_in as a failed refresh without dropping the session', async () => {
    const auth = await signIn(10);
    fetchSpy.mockResolvedValueOnce(tokenResponse('soon'));
    await expect(auth.accessToken()).resolves.toBeNull();
    fetchSpy.mockResolvedValueOnce(tokenResponse(0));
    await expect(auth.accessToken()).resolves.toBeNull();
    expect(auth.signedIn()).toBe(true);
  });

  it('keeps the previous refresh and id token when a refresh omits them', async () => {
    const auth = await signIn(10);
    fetchSpy.mockResolvedValueOnce(tokenResponse(10, 'access-2', null));
    await expect(auth.accessToken()).resolves.toBe('access-2');
    const stored = JSON.parse(localStorage.getItem('daily2.tokens')!);
    expect(stored.refreshToken).toBe('refresh-1');
    expect(stored.idToken).toEqual(expect.stringContaining('.'));
  });

  it('shares one token request between concurrent accessToken() calls', async () => {
    const auth = await signIn(10);
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'access-2'));
    const results = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(results).toEqual(['access-2', 'access-2', 'access-2']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('adopts tokens written by another tab', async () => {
    const auth = await signIn(10);
    const fresh = {
      accessToken: 'other-tab',
      refreshToken: 'r2',
      idToken: null,
      expiresAt: Date.now() + 300_000,
    };
    localStorage.setItem('daily2.tokens', JSON.stringify(fresh));
    window.dispatchEvent(new StorageEvent('storage', { key: 'daily2.tokens' }));
    fetchSpy.mockClear();
    await expect(auth.accessToken()).resolves.toBe('other-tab');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows a provider error from the callback', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/today');
    await expect(
      auth.completeLogin(
        new URLSearchParams({ error: 'access_denied', error_description: 'Nope' }),
      ),
    ).rejects.toThrow('Nope');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the verifier only once', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/today');
    const url = new URL(redirect.mock.calls[0][0] as string);
    const params = new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! });
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'a', idToken(url.searchParams.get('nonce'))));
    await auth.completeLogin(params);
    await expect(auth.completeLogin(params)).rejects.toThrow('could not be verified');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends the S256 challenge of the verifier it later posts', async () => {
    await signIn();
    const url = new URL(redirect.mock.calls[0][0] as string);
    const body = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as URLSearchParams;
    expect(url.searchParams.get('code_challenge')).toBe(
      await challengeFor(body.get('code_verifier')!),
    );
  });

  it('rejects an id token whose nonce does not match and stores nothing', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/today');
    const url = new URL(redirect.mock.calls[0][0] as string);
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'a', idToken('someone-elses')));
    await expect(
      auth.completeLogin(new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! })),
    ).rejects.toThrow('nonce');
    expect(auth.signedIn()).toBe(false);
    expect(localStorage.getItem('daily2.tokens')).toBeNull();
  });

  it('rejects a missing id token', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/today');
    const url = new URL(redirect.mock.calls[0][0] as string);
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'a', null));
    await expect(
      auth.completeLogin(new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! })),
    ).rejects.toThrow('nonce');
  });

  it('logout clears the storage and ends the Keycloak session', async () => {
    const auth = await signIn();
    redirect.mockClear();
    auth.logout();
    expect(localStorage.getItem('daily2.tokens')).toBeNull();
    expect(auth.signedIn()).toBe(false);
    const url = new URL(redirect.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      'http://kc.test/realms/daily2/protocol/openid-connect/logout',
    );
    expect(url.searchParams.get('id_token_hint')).toEqual(expect.stringContaining('.'));
    expect(url.searchParams.get('client_id')).toBe(TEST_CONFIG.clientId);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${window.location.origin}/`);
  });

  it('authGuard lets a signed-in user through and sends others to login', async () => {
    const run = (url: string) =>
      TestBed.runInInjectionContext(() => authGuard({} as never, { url } as never));
    await expect(run('/diary')).resolves.toBe(false);
    expect(new URL(redirect.mock.calls[0][0] as string).pathname).toContain('/auth');
    redirect.mockClear();
    await signIn();
    redirect.mockClear();
    await expect(run('/diary')).resolves.toBe(true);
    expect(redirect).not.toHaveBeenCalled();
  });
});
