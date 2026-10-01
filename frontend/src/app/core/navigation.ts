import {
  EnvironmentProviders,
  Injectable,
  inject,
  provideEnvironmentInitializer,
} from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';

/** Counts how many in-app steps lead to the current page, so "back" never leaves the app. */
@Injectable({ providedIn: 'root' })
export class InAppNavigation {
  private readonly router = inject(Router);
  private steps = 0;
  private started = false;
  private replace = false;
  private popstate = false;

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.replace = this.router.currentNavigation()?.extras.replaceUrl === true;
        this.popstate = event.navigationTrigger === 'popstate';
      } else if (event instanceof NavigationEnd) {
        if (!this.started) {
          this.started = true;
        } else if (this.popstate) {
          this.steps = Math.max(0, this.steps - 1);
        } else if (!this.replace) {
          this.steps += 1;
        }
      }
    });
  }

  /** True when the user reached this page by navigating inside the app. */
  get canGoBack(): boolean {
    return this.steps > 0;
  }
}

/** Start counting at bootstrap; a page injecting it later would miss earlier navigations. */
export function provideInAppNavigation(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => void inject(InAppNavigation));
}
