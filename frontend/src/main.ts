import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { loadRuntimeConfig } from './app/core/config';

loadRuntimeConfig()
  .then((config) => bootstrapApplication(App, appConfig(config)))
  .catch((error: unknown) => {
    document.body.textContent = `daily could not start: ${error instanceof Error ? error.message : error}`;
  });
