import { Location } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting } from '../../../testing/http';
import { provideInAppNavigation } from '../../core/navigation';
import { EventEditor } from '../../shared/forms/event-editor';
import { LogPage } from './log';

describe('LogPage', () => {
  function open(kind: string) {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(LogPage);
    fixture.componentRef.setInput('kind', kind);
    TestBed.tick();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  function editor(fixture: ReturnType<typeof open>['fixture']): EventEditor {
    return fixture.debugElement.query(By.directive(EventEditor)).componentInstance;
  }

  it('opens the editor for a known kind and refuses an unknown one', async () => {
    const { fixture, element } = open('sleep');
    expect(element.querySelector('app-event-editor')).not.toBeNull();
    fixture.componentRef.setInput('kind', 'dance');
    TestBed.tick();
    expect(element.textContent).toContain('Unknown kind "dance".');
  });

  it('announces the unknown kind and links back to today', () => {
    const { element } = open('dance');
    expect(element.querySelector('[role="alert"]')!.textContent).toContain('Unknown kind "dance".');
    expect(element.querySelector('a')!.getAttribute('href')).toBe('/today');
  });

  describe('leaving the page', () => {
    @Component({ template: '' })
    class Blank {}

    async function start(url: string) {
      TestBed.configureTestingModule({
        providers: [
          ...provideFeatureTesting(),
          provideRouter(
            [
              { path: 'today', component: Blank },
              { path: 'callback', component: Blank },
              { path: 'log/:kind', component: LogPage },
            ],
            withComponentInputBinding(),
          ),
          provideInAppNavigation(),
        ],
      });
      const harness = await RouterTestingHarness.create(url);
      const back = vi.spyOn(TestBed.inject(Location), 'back').mockImplementation(() => undefined);
      return { harness, back, router: TestBed.inject(Router) };
    }

    function leave(harness: RouterTestingHarness, name: 'saved' | 'cancelled'): void {
      const page = harness.routeDebugElement!.query(By.directive(EventEditor)).componentInstance;
      if (name === 'saved') {
        page.saved.emit(event());
      } else {
        page.cancelled.emit();
      }
    }

    it.each(['saved', 'cancelled'] as const)(
      'opens today after %s on a deep link',
      async (name) => {
        const { harness, back, router } = await start('/log/sleep');
        leave(harness, name);
        await vi.waitFor(() => expect(router.url).toBe('/today'));
        expect(back).not.toHaveBeenCalled();
      },
    );

    it.each(['saved', 'cancelled'] as const)(
      'opens today after %s behind a login redirect',
      async (name) => {
        const { harness, back, router } = await start('/callback');
        await router.navigateByUrl('/log/sleep', { replaceUrl: true });
        harness.fixture.detectChanges();
        leave(harness, name);
        await vi.waitFor(() => expect(router.url).toBe('/today'));
        expect(back).not.toHaveBeenCalled();
      },
    );

    it.each(['saved', 'cancelled'] as const)(
      'goes back after %s when the user came from another page of the app',
      async (name) => {
        const { harness, back, router } = await start('/today');
        await router.navigateByUrl('/log/note');
        harness.fixture.detectChanges();
        leave(harness, name);
        expect(back).toHaveBeenCalledOnce();
        expect(router.url).toBe('/log/note');
      },
    );
  });
});
