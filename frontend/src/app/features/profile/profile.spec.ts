import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideFeatureTesting, request } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import { becomeVisible } from '../../../testing/visibility';
import { context, summary } from '../../../testing/views';
import type { ProfileView } from '../../core/api/types';
import { Auth } from '../../core/auth/auth';
import { Notices } from '../../core/notices';
import { ProfilePage } from './profile';

const view: ProfileView = {
  profile: {
    id: 'p1',
    valid_from: '2026-09-01T00:00:00Z',
    timezone: 'Europe/Berlin',
    height_cm: 182,
    birth_date: '1999-05-01',
    sex: 'male',
    goal_weight_kg: 78,
    goal_date: '2026-12-31',
    protein_g_per_kg: 1.8,
    fat_g_per_kg_min: 0.8,
    gym_sessions_per_week: 3,
  },
  targets_today: summary().targets,
  source_preferences: [{ metric: 'steps', sources: ['ring', 'app'] }],
  integrations: [
    {
      source: 'gym-bro',
      configured: true,
      last_attempt_at: '2026-09-29T06:00:00Z',
      last_success_at: '2026-09-29T06:00:00Z',
      last_error: null,
      counts: { created: 2 },
    },
  ],
};

const boom = { status: 500, statusText: 'Server Error' };
const logout = vi.fn();

function open() {
  TestBed.configureTestingModule({
    providers: [...provideFeatureTesting(), { provide: Auth, useValue: { logout } }],
  });
  const fixture = TestBed.createComponent(ProfilePage);
  const element: HTMLElement = fixture.nativeElement;
  const button = (name: string) =>
    [...element.querySelectorAll('button')].find(
      (b) =>
        b.textContent?.replace(/\s+/g, ' ').trim() === name ||
        b.getAttribute('aria-label') === name,
    )!;
  const field = (name: string) => element.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const type = (name: string, value: string) => {
    field(name).value = value;
    field(name).dispatchEvent(new Event('input'));
  };
  const form = async (selector: string) => {
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector(selector)).not.toBeNull();
    });
  };
  const notices = () =>
    TestBed.inject(Notices)
      .items()
      .map((n) => n.text);
  return { fixture, element, button, field, type, form, notices };
}

async function show(page: ReturnType<typeof open>, profile: ProfileView = view) {
  (await request('/api/v2/views/profile')).flush(profile);
  (await request('/api/v2/views/today')).flush(context());
  await loaded(page.fixture, page.element);
}

async function loaded(fixture: { whenStable(): Promise<unknown> }, element: HTMLElement) {
  await vi.waitFor(async () => {
    await fixture.whenStable();
    expect(element.querySelectorAll('.derivation li').length).toBeGreaterThan(0);
  });
}

describe('ProfilePage', () => {
  beforeEach(() => logout.mockReset());

  it('shows body data, the target derivation, preferences and integrations, and syncs now', async () => {
    const { fixture, element, button } = open();
    (await request('/api/v2/views/profile')).flush(view);
    (await request('/api/v2/views/today')).flush(context());
    await loaded(fixture, element);
    expect(element.querySelector('.rows')!.textContent).toContain('Goal weight (kg)');
    expect(element.textContent).toContain('Protein 146.5 g = 1.8 g/kg × 81.4 kg');
    expect(element.textContent).toContain('steps: ring → app');
    expect(element.querySelector('.integration')!.textContent).toContain('(2 created)');
    expect(button('Edit source preference for steps')).toBeTruthy();

    button('Sync now gym-bro').click();
    const sync = await request('/api/v2/commands/sync_now');
    expect(sync.request.body).toEqual({ source: 'gym-bro', idempotency_key: expect.any(String) });
    expect(button('Sync now gym-bro').disabled).toBe(true);
    expect(button('Sync now gym-bro').getAttribute('aria-busy')).toBe('true');
    sync.flush({
      result: {
        ...view.integrations[0],
        last_attempt_at: '2026-09-29T07:00:00Z',
        last_success_at: '2026-09-29T07:00:00Z',
      },
      warnings: [],
      days: [],
    });
    await vi.waitFor(() => {
      TestBed.tick();
      expect(
        TestBed.inject(Notices)
          .items()
          .map((n) => n.text),
      ).toContain('gym-bro synced');
    });
  });

  it('shows a failed sync inline and reuses the key on retry', async () => {
    const { fixture, element, button } = open();
    (await request('/api/v2/views/profile')).flush(view);
    (await request('/api/v2/views/today')).flush(context());
    await loaded(fixture, element);
    button('Sync now gym-bro').click();
    const first = await request('/api/v2/commands/sync_now');
    const key = (first.request.body as { idempotency_key: string }).idempotency_key;
    first.flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('gym-bro');
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
    button('Sync now gym-bro').click();
    const second = await request('/api/v2/commands/sync_now');
    expect((second.request.body as { idempotency_key: string }).idempotency_key).toBe(key);
  });

  it('signs out', async () => {
    const { fixture, element, button } = open();
    (await request('/api/v2/views/profile')).flush(view);
    (await request('/api/v2/views/today')).flush(context());
    await loaded(fixture, element);
    button('Sign out').click();
    expect(logout).toHaveBeenCalledOnce();
  });

  it('shows the profile view failing as an alert without throwing', async () => {
    const { element } = open();
    (await request('/api/v2/views/profile')).flush({ title: 'Boom' }, boom);
    (await request('/api/v2/views/today')).flush(context());
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
  });

  it('still shows the profile when today fails, and says why targets are not explained', async () => {
    const { element } = open();
    (await request('/api/v2/views/profile')).flush(view);
    (await request('/api/v2/views/today')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('.rows')).toBeTruthy();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
  });

  it('raises exactly one notice for a sync that answered with an error', async () => {
    const page = open();
    await show(page);
    page.button('Sync now gym-bro').click();
    (await request('/api/v2/commands/sync_now')).flush({
      result: {
        ...view.integrations[0],
        last_attempt_at: '2026-09-29T07:00:00Z',
        last_error: 'down',
      },
      warnings: ['gym-bro sync failed: down'],
      days: [],
    });
    await vi.waitFor(() => {
      TestBed.tick();
      expect(page.notices()).toEqual(['gym-bro sync failed: down']);
    });
  });

  it('says so when the sync did not run because another one holds the lock', async () => {
    const page = open();
    await show(page);
    page.button('Sync now gym-bro').click();
    (await request('/api/v2/commands/sync_now')).flush({
      result: view.integrations[0],
      warnings: [],
      days: [],
    });
    await vi.waitFor(() => {
      TestBed.tick();
      expect(page.notices()).toEqual(['gym-bro sync already running']);
    });
  });

  it('disables Sync now for an integration that is not configured', async () => {
    const page = open();
    await show(page, { ...view, integrations: [{ ...view.integrations[0], configured: false }] });
    expect(page.button('Sync now gym-bro').disabled).toBe(true);
  });

  it('sends non-null required fields when saving a first profile', async () => {
    const page = open();
    await show(page, { ...view, profile: null });
    page.button('Edit').click();
    await page.form('[name="timezone"]');
    page.element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const save = await request('/api/v2/commands/update_profile');
    expect(save.request.body).toMatchObject({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      protein_g_per_kg: 1.8,
      fat_g_per_kg_min: 0.8,
    });
  });

  it('keeps what was typed in the profile form when the views reload', async () => {
    const page = open();
    await show(page);
    page.button('Edit').click();
    await page.form('[name="height_cm"]');
    page.type('height_cm', '190');
    page.button('Sync now gym-bro').click();
    (await request('/api/v2/commands/sync_now')).flush({
      result: { ...view.integrations[0], last_attempt_at: '2026-09-29T07:00:00Z' },
      warnings: [],
      days: [],
    });
    (await request('/api/v2/views/profile')).flush({
      ...view,
      profile: { ...view.profile!, height_cm: 185 },
    });
    (await request('/api/v2/views/today')).flush(context());
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      TestBed.tick();
      expect(page.notices()).toContain('gym-bro synced');
    });
    expect(page.field('height_cm').value).toBe('190');
  });

  it('blocks Edit until the reload after a save lands, then shows the saved values', async () => {
    const page = open();
    await show(page);
    page.button('Edit').click();
    await page.form('[name="height_cm"]');
    page.type('height_cm', '190');
    page.element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const save = await request('/api/v2/commands/update_profile');
    save.flush({ result: { ...view.profile!, height_cm: 190 }, warnings: [], days: [] });
    const reload = await request('/api/v2/views/profile');
    await vi.waitFor(() => {
      TestBed.tick();
      expect(page.element.querySelector('form')).toBeNull();
      expect(page.button('Edit').disabled).toBe(true);
      expect(page.button('Edit source preference for steps').disabled).toBe(true);
      expect(page.button('Add preference').disabled).toBe(true);
    });
    reload.flush({ ...view, profile: { ...view.profile!, height_cm: 190 } });
    (await request('/api/v2/views/today')).flush(context());
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      TestBed.tick();
      expect(page.button('Edit').disabled).toBe(false);
    });
    page.button('Edit').click();
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      expect(page.field('height_cm')).not.toBeNull();
    });
    expect(page.field('height_cm').value).toBe('190');
  });

  it('opens only one editor at a time', async () => {
    const page = open();
    await show(page);
    page.button('Edit').click();
    await page.form('[name="height_cm"]');
    expect(page.button('Edit source preference for steps')).toBeUndefined();
    expect(page.button('Add preference')).toBeUndefined();
  });

  it('hides the profile Edit while a preference is edited', async () => {
    const page = open();
    await show(page);
    page.button('Edit source preference for steps').click();
    await page.form('form');
    expect(page.button('Edit')).toBeUndefined();
  });

  it('adds a preference for a typed metric', async () => {
    const page = open();
    await show(page);
    page.button('Add preference').click();
    await page.form('[name="metric"]');
    page.type('metric', 'weight_kg');
    page.element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const save = await request('/api/v2/commands/set_source_preference');
    expect(save.request.body).toMatchObject({ metric: 'weight_kg' });
  });

  it('edits a preference without letting the metric change', async () => {
    const page = open();
    await show(page);
    page.button('Edit source preference for steps').click();
    await page.form('form');
    expect(page.field('metric')).toBeNull();
    page.element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const save = await request('/api/v2/commands/set_source_preference');
    expect(save.request.body).toMatchObject({ metric: 'steps', sources: ['ring', 'app'] });
  });

  it('shows a status while loading and no empty derivation while today loads', async () => {
    const page = open();
    page.fixture.detectChanges();
    expect(page.element.querySelector('[role="status"]')?.textContent).toContain('Loading');
    (await request('/api/v2/views/profile')).flush(view);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(page.element.querySelector('.rows')).toBeTruthy();
    });
    expect(page.element.querySelector('.derivation')).toBeNull();
    expect(page.element.querySelector('[role="status"]')?.textContent).toContain('Loading targets');
  });

  describe('after midnight', () => {
    afterEach(() => vi.useRealTimers());

    it('reloads the targets only when the day changed since the last load', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 29, 23, 50) });
      const page = open();
      await show(page);
      const backend = TestBed.inject(HttpTestingController);
      vi.setSystemTime(new Date(2026, 8, 29, 23, 59));
      becomeVisible();
      TestBed.tick();
      backend.expectNone('/api/v2/views/today');
      vi.setSystemTime(new Date(2026, 8, 30, 0, 5));
      becomeVisible();
      (await request('/api/v2/views/today')).flush(context());
    });
  });
});
