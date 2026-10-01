import { Provider } from '@angular/core';
import { RUNTIME_CONFIG, RuntimeConfig } from '../app/core/config';

/** A complete runtime config for tests. */
export const TEST_CONFIG: RuntimeConfig = {
  apiBase: '/api/v2',
  keycloakUrl: 'http://kc.test',
  realm: 'daily2',
  clientId: 'daily2-app',
};

/** The runtime config every TestBed needs. */
export function provideTestConfig(): Provider {
  return { provide: RUNTIME_CONFIG, useValue: TEST_CONFIG };
}
