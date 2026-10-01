import { Component, inject } from '@angular/core';
import { Auth } from './auth';

/** /signed-out: the API kept refusing a fresh login, so stop redirecting and ask the user. */
@Component({
  selector: 'app-signed-out',
  template: `
    <p class="form-error">Signed out. The server did not accept your sign-in.</p>
    <button type="button" (click)="signIn()">Sign in</button>
  `,
})
export class SignedOut {
  private readonly auth = inject(Auth);

  protected signIn(): void {
    void this.auth.login('/today');
  }
}
