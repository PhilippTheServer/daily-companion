import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Auth } from './auth';

/** /callback: Keycloak sends the browser here with the code; finish the login and move on. */
@Component({
  selector: 'app-callback',
  template: `
    @if (error(); as message) {
      <p class="form-error">{{ message }}</p>
      <button type="button" (click)="retry()">Sign in again</button>
    } @else {
      <p class="muted">Signing in…</p>
    }
  `,
})
export class Callback implements OnInit {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);

  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const returnTo = await this.auth.completeLogin(new URLSearchParams(window.location.search));
      await this.router.navigateByUrl(returnTo, { replaceUrl: true });
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected retry(): void {
    void this.auth.login('/today');
  }
}
