import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth';
import { RUNTIME_CONFIG, RuntimeConfig } from './core/config';
import { provideInAppNavigation } from './core/navigation';

/** Providers for the app, given the runtime config loaded before bootstrap. */
export function appConfig(config: RuntimeConfig): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      { provide: RUNTIME_CONFIG, useValue: config },
      provideRouter(routes, withComponentInputBinding()),
      provideInAppNavigation(),
      provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
      provideServiceWorker('ngsw-worker.js', {
        enabled: !isDevMode(),
        registrationStrategy: 'registerWhenStable:30000',
      }),
    ],
  };
}
