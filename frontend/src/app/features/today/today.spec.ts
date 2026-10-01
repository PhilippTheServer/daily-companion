import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request } from '../../../testing/http';
import { becomeVisible } from '../../../testing/visibility';
import { context } from '../../../testing/views';
import { Api } from '../../core/api/api';
import { TodayPage } from './today';

const FAIL = { status: 500, statusText: 'Server Error' };

describe('TodayPage', () => {
  it('shows the four gauges, warnings and the timeline, and reloads after a command', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/today')).flush(context([event()]));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('app-gauge')).toHaveLength(4);
    });
    expect(element.querySelector('.warnings')!.textContent).toContain('no weight for 7 days');
    expect(element.querySelectorAll('app-timeline li')).toHaveLength(1);
    expect(element.textContent).toContain('Weight 81.4 kg');

    TestBed.inject(Api).revision.update((value) => value + 1);
    const reload = await request('/api/v2/views/today');
    expect(element.querySelectorAll('app-gauge')).toHaveLength(4);
    reload.flush(context([]));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('app-timeline li')).toHaveLength(1);
      expect(element.textContent).toContain('Nothing logged yet.');
    });
  });

  it('opens the kind picker from the + button', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/today')).flush(context());
    await fixture.whenStable();
    element.querySelector<HTMLButtonElement>('button.add')!.click();
    await fixture.whenStable();
    const links = [...element.querySelectorAll('.kind-picker a')];
    expect(links).toHaveLength(11);
    expect(links[0].getAttribute('href')).toBe('/log/intake');
  });

  it('shows a loading state until the context arrives', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    const call = await request('/api/v2/views/today');
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Loading…');
    expect(element.querySelector('app-gauge')).toBeNull();
    call.flush(context());
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).not.toContain('Loading…');
    });
  });

  it('renders the error text when the context fails with 500', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/today')).flush({ message: 'boom' }, FAIL);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('.form-error[role="alert"]')).not.toBeNull();
    });
    expect(element.querySelector('app-gauge')).toBeNull();
    expect(element.textContent).not.toContain('Loading…');
  });

  for (const [trend, text] of [
    [-0.3, '14-day trend -0.3 kg/week'],
    [0.4, '14-day trend +0.4 kg/week'],
  ] as const) {
    it(`shows the 14-day trend ${trend} with its sign`, async () => {
      TestBed.configureTestingModule({ providers: provideFeatureTesting() });
      const fixture = TestBed.createComponent(TodayPage);
      const element: HTMLElement = fixture.nativeElement;
      const data = context();
      data.weight.trend_kg_per_week = trend;
      (await request('/api/v2/views/today')).flush(data);
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(element.querySelector('p.muted')).not.toBeNull();
      });
      const line = element.querySelector('p.muted')!.textContent!.replace(/\s+/g, ' ');
      expect(line).toContain(text);
    });
  }

  it('shows the symptoms section only when there are recent symptoms', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    const data = context();
    data.recent_symptoms = [event({ id: 's-1', kind: 'symptom', payload: { type: 'headache' } })];
    (await request('/api/v2/views/today')).flush(data);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('Symptoms, last 3 days');
    });
    expect(element.querySelectorAll('app-timeline')).toHaveLength(2);

    TestBed.inject(Api).revision.update((value) => value + 1);
    (await request('/api/v2/views/today')).flush(context());
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).not.toContain('Symptoms, last 3 days');
    });
    expect(element.querySelectorAll('app-timeline')).toHaveLength(1);
  });

  it('toggles aria-expanded and points aria-controls at the picker', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/today')).flush(context());
    await fixture.whenStable();
    const button = element.querySelector<HTMLButtonElement>('button.add')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    await fixture.whenStable();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const picker = element.querySelector('.kind-picker')!;
    expect(picker.id).not.toBe('');
    expect(button.getAttribute('aria-controls')).toBe(picker.id);
    button.click();
    await fixture.whenStable();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(element.querySelector('.kind-picker')).toBeNull();
  });

  describe('after midnight', () => {
    afterEach(() => vi.useRealTimers());

    async function shown() {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 29, 23, 50) });
      TestBed.configureTestingModule({ providers: provideFeatureTesting() });
      const fixture = TestBed.createComponent(TodayPage);
      (await request('/api/v2/views/today')).flush(context());
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(fixture.nativeElement.querySelector('app-gauge')).not.toBeNull();
      });
      return fixture;
    }

    it('does not reload when the tab returns on the same day', async () => {
      await shown();
      vi.setSystemTime(new Date(2026, 8, 29, 23, 59));
      becomeVisible();
      TestBed.tick();
      TestBed.inject(HttpTestingController).expectNone('/api/v2/views/today');
    });

    it('reloads when the tab returns on another day', async () => {
      await shown();
      vi.setSystemTime(new Date(2026, 8, 30, 0, 5));
      becomeVisible();
      (await request('/api/v2/views/today')).flush(context());
    });

    it('stops listening once the page is destroyed', async () => {
      const fixture = await shown();
      fixture.destroy();
      vi.setSystemTime(new Date(2026, 8, 30, 0, 5));
      becomeVisible();
      TestBed.inject(HttpTestingController).expectNone('/api/v2/views/today');
    });
  });
});
