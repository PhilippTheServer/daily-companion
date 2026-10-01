import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { RUNTIME_CONFIG } from '../config';
import { toApiError } from './errors';
import type {
  CommandInput,
  CommandName,
  CommandResult,
  SchemasOut,
  ViewName,
  ViewParams,
  ViewResult,
} from './types';

function queryParams(params: object | undefined): HttpParams {
  let result = new HttpParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && item !== undefined && item !== '') {
        result = result.append(key, String(item));
      }
    }
  }
  return result;
}

/** Typed access to /api/v2: views, commands and schemas. Every failure is an ApiError. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  private readonly base = inject(RUNTIME_CONFIG).apiBase;
  private schemaCache: Promise<SchemasOut> | null = null;

  /** Bumped after every successful command, so views that read it load again. */
  readonly revision = signal(0);

  /** Load a view; query parameters that are null, undefined or empty are skipped. */
  view<V extends ViewName>(name: V, params?: ViewParams<V>): Promise<ViewResult<V>> {
    const url = `${this.base}/views/${name}`;
    return this.call(this.http.get<ViewResult<V>>(url, { params: queryParams(params) }));
  }

  /** Run a command; on success `revision` is bumped so views reload. */
  async command<C extends CommandName>(name: C, body: CommandInput<C>): Promise<CommandResult<C>> {
    const url = `${this.base}/commands/${name}`;
    const result = await this.call(this.http.post<CommandResult<C>>(url, body));
    this.revision.update((value) => value + 1);
    return result;
  }

  /** The JSON Schemas of commands and payloads, loaded once per session. */
  schemas(): Promise<SchemasOut> {
    this.schemaCache ??= this.call(this.http.get<SchemasOut>(`${this.base}/schemas`)).catch(
      (error: unknown) => {
        this.schemaCache = null;
        throw error;
      },
    );
    return this.schemaCache;
  }

  private async call<T>(request: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request);
    } catch (error) {
      throw toApiError(error);
    }
  }
}

/**
 * Reload a view after every command while it stays on screen with its current value (a
 * changed resource parameter would blank it). Call in an injection context.
 */
export function reloadAfterCommands(view: { reload(): boolean }): void {
  const revision = inject(Api).revision;
  const initial = untracked(revision);
  effect(() => {
    if (revision() !== initial) {
      untracked(() => view.reload());
    }
  });
}
