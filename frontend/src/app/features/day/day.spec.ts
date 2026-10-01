import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideFeatureTesting, request } from '../../../testing/http';
import { dayView } from '../../../testing/views';
import { Api } from '../../core/api/api';
import { DayPage } from './day';

const FAIL = { status: 500, statusText: 'Server Error' };

declare const process: { env: Record<string, string | undefined> };

async function neighbours(date: string): Promise<(string | null)[]> {
  TestBed.configureTestingModule({ providers: provideFeatureTesting() });
  const fixture = TestBed.createComponent(DayPage);
  fixture.componentRef.setInput('date', date);
  (await request('/api/v2/views/day')).flush(dayView([], date));
  await fixture.whenStable();
  const element: HTMLElement = fixture.nativeElement;
  return [...element.querySelectorAll('.page-head a')].map((a) => a.getAttribute('href'));
}

describe('DayPage', () => {
  it('loads the date from the route and links the neighbouring days', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(DayPage);
    fixture.componentRef.setInput('date', '2026-09-01');
    const call = await request('/api/v2/views/day');
    expect(call.request.params.get('date')).toBe('2026-09-01');
    call.flush(dayView([], '2026-09-01'));
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('app-gauge')).toHaveLength(4);
    const links = [...element.querySelectorAll('.page-head a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/day/2026-08-31', '/day/2026-09-02']);
  });

  it('links the neighbouring days correctly around the Europe/Berlin DST switches', async () => {
    const previous = process.env['TZ'];
    process.env['TZ'] = 'Europe/Berlin';
    try {
      expect(await neighbours('2026-03-29')).toEqual(['/day/2026-03-28', '/day/2026-03-30']);
      TestBed.resetTestingModule();
      expect(await neighbours('2026-10-25')).toEqual(['/day/2026-10-24', '/day/2026-10-26']);
    } finally {
      if (previous === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = previous;
      }
    }
  });

  it('shows a loading state until the day arrives', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(DayPage);
    fixture.componentRef.setInput('date', '2026-09-01');
    const element: HTMLElement = fixture.nativeElement;
    const call = await request('/api/v2/views/day');
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Loading…');
    call.flush(dayView([], '2026-09-01'));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).not.toContain('Loading…');
    });
  });

  it('renders the error text when the day fails with 500', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(DayPage);
    fixture.componentRef.setInput('date', '2026-09-01');
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/day')).flush({ message: 'boom' }, FAIL);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('.form-error[role="alert"]')).not.toBeNull();
    });
    expect(element.querySelector('app-gauge')).toBeNull();
    expect(element.querySelectorAll('.page-head a')).toHaveLength(2);
  });

  it('reloads the same date when the commands revision changes, and renders a failed reload', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(DayPage);
    fixture.componentRef.setInput('date', '2026-09-01');
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/day')).flush(dayView([], '2026-09-01'));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('app-gauge')).toHaveLength(4);
    });

    TestBed.inject(Api).revision.update((value) => value + 1);
    const reload = await request('/api/v2/views/day');
    expect(reload.request.params.get('date')).toBe('2026-09-01');
    reload.flush({ message: 'boom' }, FAIL);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('.form-error[role="alert"]')).not.toBeNull();
    });
  });

  for (const date of ['garbage', '2026-02-30']) {
    it(`does not call the API for the invalid date ${date}`, async () => {
      TestBed.configureTestingModule({ providers: provideFeatureTesting() });
      const fixture = TestBed.createComponent(DayPage);
      fixture.componentRef.setInput('date', date);
      const element: HTMLElement = fixture.nativeElement;
      await fixture.whenStable();
      TestBed.inject(HttpTestingController).expectNone(() => true);
      expect(element.textContent).toContain('Not a valid date');
      expect(element.querySelector('a[href="/today"]')).not.toBeNull();
      expect(element.querySelector('[aria-label="Day before"]')).toBeNull();
      expect(element.querySelector('[aria-label="Day after"]')).toBeNull();
      expect(element.querySelector('app-gauge')).toBeNull();
    });
  }
});
