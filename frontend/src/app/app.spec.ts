import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { authGuard } from './core/auth/auth';

describe('App', () => {
  it('shows the four main tabs', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const tabs = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.tabs a')];
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual([
      '/today',
      '/diary',
      '/catalog',
      '/profile',
    ]);
  });

  it('keeps /callback and /signed-out outside the login guard', () => {
    expect(routes[0]).toMatchObject({ path: 'callback' });
    expect(routes[1]).toMatchObject({ path: 'signed-out' });
    expect(routes[1].canActivateChild).toBeUndefined();
    expect(routes[2].canActivateChild).toEqual([authGuard]);
  });

  it('routes every screen of spec §8 behind the login guard', () => {
    expect(routes[2].children!.map((route) => route.path)).toEqual([
      '',
      'today',
      'day/:date',
      'diary',
      'event/:chain',
      'log/:kind',
      'catalog',
      'catalog/food/:id',
      'catalog/recipe/:id',
      'profile',
      '**',
    ]);
  });
});
