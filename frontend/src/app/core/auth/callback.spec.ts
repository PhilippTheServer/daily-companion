import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Auth } from './auth';
import { Callback } from './callback';

describe('Callback', () => {
  it('finishes the login and goes where the user wanted to go', async () => {
    const auth = { completeLogin: vi.fn().mockResolvedValue('/diary'), login: vi.fn() };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: Auth, useValue: auth }],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(Callback);
    await fixture.whenStable();
    expect(auth.completeLogin).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/diary', { replaceUrl: true });
  });

  it('shows why the login failed and offers to sign in again', async () => {
    const auth = {
      completeLogin: vi.fn().mockRejectedValue(new Error('state mismatch')),
      login: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: Auth, useValue: auth }],
    });
    const fixture = TestBed.createComponent(Callback);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.form-error')!.textContent).toBe('state mismatch');
    element.querySelector('button')!.click();
    expect(auth.login).toHaveBeenCalledWith('/today');
  });
});
