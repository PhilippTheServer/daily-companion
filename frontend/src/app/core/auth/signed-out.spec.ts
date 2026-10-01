import { TestBed } from '@angular/core/testing';
import { Auth } from './auth';
import { SignedOut } from './signed-out';

describe('SignedOut', () => {
  it('explains the state and offers to sign in', async () => {
    const auth = { login: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: Auth, useValue: auth }] });
    const fixture = TestBed.createComponent(SignedOut);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('Signed out');
    element.querySelector('button')!.click();
    expect(auth.login).toHaveBeenCalledWith('/today');
  });
});
