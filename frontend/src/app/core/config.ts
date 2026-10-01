import { InjectionToken } from '@angular/core';

/** Deployment settings read at startup from assets/runtime-config.json; one image runs anywhere. */
export interface RuntimeConfig {
  apiBase: string;
  keycloakUrl: string;
  realm: string;
  clientId: string;
}

/** Injection token for the loaded runtime config. */
export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG');

const KEYS: (keyof RuntimeConfig)[] = ['apiBase', 'keycloakUrl', 'realm', 'clientId'];

/** Fetch and check runtime-config.json; a missing or partial file stops the app loudly. */
export async function loadRuntimeConfig(fetchFn: typeof fetch = fetch): Promise<RuntimeConfig> {
  const response = await fetchFn('assets/runtime-config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`runtime-config.json: HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error('runtime-config.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('runtime-config.json must contain a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  const missing = KEYS.filter((key) => typeof raw[key] !== 'string' || raw[key] === '');
  if (missing.length) {
    throw new Error(`runtime-config.json is missing ${missing.join(', ')}`);
  }
  return Object.fromEntries(KEYS.map((key) => [key, raw[key]])) as unknown as RuntimeConfig;
}
