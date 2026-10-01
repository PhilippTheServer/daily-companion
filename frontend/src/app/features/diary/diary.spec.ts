import { HttpTestingController } from '@angular/common/http/testing';
import { By } from '@angular/platform-browser';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Api } from '../../core/api/api';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request } from '../../../testing/http';
import { Visible } from '../../shared/timeline/visible';
import { DiaryPage } from './diary';

describe('DiaryPage', () => {
  let fixture: ComponentFixture<DiaryPage>;
  let element: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(DiaryPage);
    element = fixture.nativeElement;
  });

  function button(text: string): HTMLButtonElement {
    return [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  }

  it('pages through older days with the cursor and appends them', async () => {
    const first = await request('/api/v2/views/diary');
    expect(first.request.params.keys()).toEqual(['days']);
    expect(first.request.params.get('days')).toBe('7');
    first.flush({
      days: [
        { day: '2026-09-29', events: [event({ id: 'a' }), event({ id: 'b' })] },
        { day: '2026-09-27', events: [event({ id: 'c' })] },
      ],
      next_cursor: 'cursor-1',
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('.diary-day')).toHaveLength(2);
    });
    expect(element.querySelectorAll('app-timeline li')).toHaveLength(3);

    button('Load older days').click();
    const second = await request('/api/v2/views/diary');
    expect(second.request.params.get('cursor')).toBe('cursor-1');
    second.flush({
      days: [{ day: '2026-09-20', events: [event({ id: 'd' })] }],
      next_cursor: null,
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('.diary-day')).toHaveLength(3);
    });
    expect(element.textContent).toContain('No older entries.');
    expect(button('Load older days')).toBeUndefined();
  });

  it('starts over with a kind filter', async () => {
    (await request('/api/v2/views/diary')).flush({ days: [], next_cursor: null });
    await fixture.whenStable();
    button('Symptom').click();
    const filtered = await request('/api/v2/views/diary');
    expect(filtered.request.params.getAll('kinds')).toEqual(['symptom']);
    expect(filtered.request.params.has('cursor')).toBe(false);
    filtered.flush({ days: [], next_cursor: null });
  });
});

describe('DiaryPage paging guards', () => {
  let fixture: ComponentFixture<DiaryPage>;
  let element: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(DiaryPage);
    element = fixture.nativeElement;
  });

  function sentinel(): void {
    fixture.debugElement.query(By.directive(Visible)).injector.get(Visible).appVisible.emit();
  }

  async function settle(check: () => void): Promise<void> {
    await vi.waitFor(() => {
      TestBed.tick();
      check();
    });
  }

  it('sends one request for repeated sentinel emits and none after the end', async () => {
    (await request('/api/v2/views/diary')).flush({
      days: [{ day: '2026-09-29', events: [event()] }],
      next_cursor: 'c1',
    });
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    sentinel();
    sentinel();
    const older = await request('/api/v2/views/diary');
    older.flush({ days: [], next_cursor: null });
    await settle(() => expect(element.textContent).toContain('No older entries.'));
    const backend = TestBed.inject(HttpTestingController);
    (fixture.componentInstance as unknown as { auto(): void }).auto();
    TestBed.tick();
    backend.expectNone('/api/v2/views/diary');
  });

  it('drops a page that arrives after a restart', async () => {
    (await request('/api/v2/views/diary')).flush({
      days: [{ day: '2026-09-29', events: [event()] }],
      next_cursor: 'c1',
    });
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    const stale = await (async () => {
      sentinel();
      return request('/api/v2/views/diary');
    })();
    const symptom = [...element.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Symptom',
    )!;
    symptom.click();
    const fresh = await request((r) => r.params.getAll('kinds')?.length === 1);
    fresh.flush({ days: [{ day: '2026-09-28', events: [event({ id: 'n' })] }], next_cursor: null });
    await settle(() => expect(element.textContent).toContain('No older entries.'));
    stale.flush({
      days: [{ day: '2026-09-01', events: [event({ id: 'old' })] }],
      next_cursor: null,
    });
    TestBed.tick();
    const days = [...element.querySelectorAll('.day-head a')].map((a) => a.getAttribute('href'));
    expect(days).toEqual(['/day/2026-09-28']);
  });

  it('shows a failed page, keeps loaded days and retries through the button', async () => {
    (await request('/api/v2/views/diary')).flush({
      days: [{ day: '2026-09-29', events: [event()] }],
      next_cursor: 'c1',
    });
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    sentinel();
    (await request('/api/v2/views/diary')).flush(
      { title: 'Boom' },
      { status: 500, statusText: 'Server Error' },
    );
    await settle(() => expect(element.querySelector('.form-error')).not.toBeNull());
    expect(element.querySelectorAll('.diary-day')).toHaveLength(1);
    sentinel();
    TestBed.tick();
    TestBed.inject(HttpTestingController).expectNone('/api/v2/views/diary');
    const retry = [...element.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Load older days',
    )!;
    retry.click();
    const again = await request('/api/v2/views/diary');
    expect(again.request.params.get('cursor')).toBe('c1');
    again.flush({ days: [{ day: '2026-09-20', events: [event({ id: 'z' })] }], next_cursor: null });
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(2));
    expect(element.querySelector('.form-error')).toBeNull();
  });
});

describe('DiaryPage state and failures', () => {
  let fixture: ComponentFixture<DiaryPage>;
  let element: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(DiaryPage);
    element = fixture.nativeElement;
  });

  function button(text: string): HTMLButtonElement {
    return [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  }

  async function settle(check: () => void): Promise<void> {
    await vi.waitFor(() => {
      TestBed.tick();
      check();
    });
  }

  const page = (id: string, day: string, cursor: string | null) => ({
    days: [{ day, events: [event({ id })] }],
    next_cursor: cursor,
  });

  it('marks the active filter chips as pressed and un-presses them on toggle', async () => {
    (await request('/api/v2/views/diary')).flush(page('a', '2026-09-29', null));
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    expect(button('Symptom').getAttribute('aria-pressed')).toBe('false');
    button('Symptom').click();
    (await request((r) => r.params.getAll('kinds')?.length === 1)).flush(
      page('b', '2026-09-28', null),
    );
    await settle(() => expect(button('Symptom').getAttribute('aria-pressed')).toBe('true'));
    expect(button('Meal').getAttribute('aria-pressed')).toBe('false');
    button('Symptom').click();
    const cleared = await request((r) => !r.params.has('kinds'));
    cleared.flush(page('c', '2026-09-27', null));
    await settle(() => expect(button('Symptom').getAttribute('aria-pressed')).toBe('false'));
  });

  it('clears old days and drops the cursor when the filter changes', async () => {
    (await request('/api/v2/views/diary')).flush(page('a', '2026-09-29', 'c1'));
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    button('Symptom').click();
    TestBed.tick();
    expect(element.querySelectorAll('.diary-day')).toHaveLength(0);
    const filtered = await request((r) => r.params.getAll('kinds')?.length === 1);
    expect(filtered.request.params.has('cursor')).toBe(false);
    filtered.flush(page('b', '2026-09-28', null));
    await settle(() => expect(element.querySelectorAll('.day-head a')).toHaveLength(1));
    expect(element.querySelector('.day-head a')?.getAttribute('href')).toBe('/day/2026-09-28');
  });

  it('restarts from the newest day when the commands revision changes', async () => {
    (await request('/api/v2/views/diary')).flush(page('a', '2026-09-29', 'c1'));
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    button('Load older days').click();
    (await request((r) => r.params.get('cursor') === 'c1')).flush(page('b', '2026-09-20', 'c2'));
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(2));

    TestBed.inject(Api).revision.update((value) => value + 1);
    TestBed.tick();
    expect(element.querySelectorAll('.diary-day')).toHaveLength(0);
    const fresh = await request('/api/v2/views/diary');
    expect(fresh.request.params.has('cursor')).toBe(false);
    fresh.flush(page('n', '2026-09-30', null));
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    expect(element.querySelector('.day-head a')?.getAttribute('href')).toBe('/day/2026-09-30');
  });

  it('drops the failure of a stale request', async () => {
    const stale = await request('/api/v2/views/diary');
    button('Symptom').click();
    const fresh = await request((r) => r.params.getAll('kinds')?.length === 1);
    stale.flush({ title: 'Boom' }, { status: 500, statusText: 'Server Error' });
    fresh.flush(page('n', '2026-09-28', null));
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).not.toContain('HTTP 500');
  });

  it('shows an initial failure with the button and retries through it', async () => {
    (await request('/api/v2/views/diary')).flush(
      { title: 'Boom' },
      { status: 500, statusText: 'Server Error' },
    );
    await settle(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    expect(element.querySelectorAll('.diary-day')).toHaveLength(0);
    expect(button('Load older days')).toBeInstanceOf(HTMLButtonElement);
    expect(button('Load older days').disabled).toBe(false);
    button('Load older days').click();
    (await request('/api/v2/views/diary')).flush(page('a', '2026-09-29', null));
    await settle(() => expect(element.querySelectorAll('.diary-day')).toHaveLength(1));
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('says so when nothing is logged yet', async () => {
    (await request('/api/v2/views/diary')).flush({ days: [], next_cursor: null });
    await settle(() => expect(element.textContent).toContain('Nothing logged yet.'));
    expect(element.textContent).not.toContain('No older entries.');
  });
});

describe('DiaryPage sentinel arming', () => {
  class StubObserver {
    static instances: StubObserver[] = [];
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
    constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
      StubObserver.instances.push(this);
    }
  }

  let fixture: ComponentFixture<DiaryPage>;
  let element: HTMLElement;

  beforeEach(() => {
    StubObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', StubObserver);
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(DiaryPage);
    element = fixture.nativeElement;
  });

  afterEach(() => vi.unstubAllGlobals());

  const observer = () => StubObserver.instances[0];
  const inView = () => observer().callback([{ isIntersecting: true }]);
  const page = (id: string, day: string, cursor: string | null) => ({
    days: [{ day, events: [event({ id })] }],
    next_cursor: cursor,
  });
  async function settle(check: () => void): Promise<void> {
    await vi.waitFor(() => {
      TestBed.tick();
      check();
    });
  }

  it('observes again only after a page loaded, so a failure ends the emits', async () => {
    const first = await request('/api/v2/views/diary');
    expect(observer().observe).toHaveBeenCalledTimes(1);
    inView();
    first.flush(page('a', '2026-09-29', 'c1'));
    await settle(() => expect(observer().observe).toHaveBeenCalledTimes(2));

    inView();
    (await request('/api/v2/views/diary')).flush(
      { title: 'Boom' },
      { status: 500, statusText: 'Server Error' },
    );
    await settle(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());
    expect(observer().observe).toHaveBeenCalledTimes(2);
    inView();
    TestBed.tick();
    TestBed.inject(HttpTestingController).expectNone('/api/v2/views/diary');

    [...element.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Load older days')!
      .click();
    (await request('/api/v2/views/diary')).flush(page('b', '2026-09-20', 'c2'));
    await settle(() => expect(observer().observe).toHaveBeenCalledTimes(3));
  });
});
