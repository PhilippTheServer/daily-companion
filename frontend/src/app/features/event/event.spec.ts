import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request, requests } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import { dayView } from '../../../testing/views';
import type { EventHistory } from '../../core/api/types';
import { Api } from '../../core/api/api';
import { Notices } from '../../core/notices';
import { dayLabel } from '../../shared/time';
import { EventPage } from './event';

const history: EventHistory = {
  chain_id: 'c-1',
  kind: 'symptom',
  versions: [
    event({ id: 'v1', kind: 'symptom', version: 1, payload: { type: 'bloated', severity: 2 } }),
    event({
      id: 'v2',
      kind: 'symptom',
      version: 2,
      source: 'claude',
      payload: { type: 'bloated', severity: 4 },
      recorded_at: '2026-09-29T12:02:00Z',
    }),
  ],
  links: [{ chain_id: 'c-breakfast', relation: 'suspected_cause', direction: 'outgoing' }],
};

describe('EventPage', () => {
  let fixture: ComponentFixture<EventPage>;
  let element: HTMLElement;

  const view = (chain: string) =>
    request((r) => r.url === '/api/v2/views/event' && r.params.get('chain_id') === chain);

  const breakfast: EventHistory = {
    chain_id: 'c-breakfast',
    kind: 'intake',
    versions: [
      event({ kind: 'intake', chain_id: 'c-breakfast', payload: { slot: 'breakfast', items: [] } }),
    ],
    links: [],
  };

  const stale = { code: 'stale_head', message: 'was already corrected', field: 'id' };
  const boom = { status: 500, statusText: 'Server Error' };

  async function open(shown: EventHistory = history): Promise<void> {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(EventPage);
    fixture.componentRef.setInput('chain', 'c-1');
    element = fixture.nativeElement;
    (await view('c-1')).flush(shown);
    const other = await view('c-breakfast');
    other.flush(breakfast);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('app-link-row a')!.textContent).toContain('Breakfast');
    });
  }

  async function settle(): Promise<void> {
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('h1')).not.toBeNull();
    });
  }

  function type(name: string, value: string): void {
    const input = element.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  async function submitRetract() {
    button('Retract').click();
    await fixture.whenStable();
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    return request('/api/v2/commands/retract_event');
  }

  function button(text: string): HTMLButtonElement {
    return [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  }

  it('shows the head, its links and the history newest first', async () => {
    await open();
    expect(element.querySelector('h1')!.textContent).toBe('Bloated');
    expect(element.textContent).toContain('severity 4/5');
    expect(element.querySelector('app-link-row')!.textContent).toContain('Suspected cause:');
    const versions = [...element.querySelectorAll('.history li')].map((li) => li.textContent);
    expect(versions[0]).toMatch(/^v2 · corrected by claude at/);
    expect(versions[1]).toMatch(/^v1 · logged by app at/);
  });

  it('retracts the head with a reason', async () => {
    await open();
    button('Retract').click();
    await fixture.whenStable();
    const reason = element.querySelector<HTMLInputElement>('[name="reason"]')!;
    reason.value = 'logged twice';
    reason.dispatchEvent(new Event('input'));
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const call = await request('/api/v2/commands/retract_event');
    expect(call.request.body).toEqual({
      id: 'v2',
      reason: 'logged twice',
      idempotency_key: expect.any(String),
    });
  });

  it('links to an entry of the same day or the day before', async () => {
    await open();
    button('Link').click();
    const [before, same] = await requests('/api/v2/views/day', 2);
    expect(before.request.params.get('date')).toBe('2026-09-28');
    before.flush(dayView([], '2026-09-28'));
    same.flush(
      dayView([event({ id: 'lunch', chain_id: 'c-lunch', kind: 'note', payload: { text: 'x' } })]),
    );
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('.candidates button')).toHaveLength(1);
    });
    element.querySelector<HTMLButtonElement>('.candidates button')!.click();
    const call = await request('/api/v2/commands/link_events');
    expect(call.request.body).toEqual({
      from_chain: 'c-1',
      to_chain: 'c-lunch',
      relation: 'suspected_cause',
      idempotency_key: expect.any(String),
    });
  });

  it('unlinks in the stored direction', async () => {
    await open();
    button('Unlink').click();
    const call = await request('/api/v2/commands/unlink_events');
    expect(call.request.body).toEqual({
      from_chain: 'c-1',
      to_chain: 'c-breakfast',
      relation: 'suspected_cause',
      idempotency_key: expect.any(String),
    });
  });

  it('renders a failed load as an alert without throwing', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(EventPage);
    fixture.componentRef.setInput('chain', 'c-1');
    element = fixture.nativeElement;
    (await request('/api/v2/views/event')).flush(
      { title: 'Boom' },
      { status: 500, statusText: 'Server Error' },
    );
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
  });

  it('keeps the retract key across a failure and renews it after success', async () => {
    await open();
    const first = await submitRetract();
    const key = (first.request.body as { idempotency_key: string }).idempotency_key;
    expect(key).toBeTruthy();
    first.flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('form [role="alert"]')).not.toBeNull();
    });
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const second = await request('/api/v2/commands/retract_event');
    expect((second.request.body as { idempotency_key: string }).idempotency_key).toBe(key);
    second.flush({});
    (await view('c-1')).flush(history);
    (await view('c-breakfast')).flush(breakfast);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('form')).toBeNull();
    });
    const third = await submitRetract();
    expect((third.request.body as { idempotency_key: string }).idempotency_key).not.toBe(key);
  });

  it('sends a retract only once while it is in flight', async () => {
    await open();
    button('Retract').click();
    await fixture.whenStable();
    const form = element.querySelector('form')!;
    form.dispatchEvent(new Event('submit'));
    form.dispatchEvent(new Event('submit'));
    const call = await request('/api/v2/commands/retract_event');
    TestBed.tick();
    const backend = TestBed.inject(HttpTestingController);
    expect(backend.match('/api/v2/commands/retract_event')).toHaveLength(0);
    expect(call.cancelled).toBe(false);
  });

  it('shows the reason of the reloaded retracted head, not the one typed here', async () => {
    await open();
    button('Retract').click();
    await fixture.whenStable();
    type('reason', 'typed here');
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    (await request('/api/v2/commands/retract_event')).flush({});
    const reloaded = await view('c-1');
    const head = history.versions[1];
    reloaded.flush({
      ...history,
      versions: [
        history.versions[0],
        { ...head, retracted: true, retract_reason: 'stored on the server' },
      ],
    });
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('.retracted-note')?.textContent).toContain(
        'Reason: stored on the server',
      );
    });
    expect(element.querySelector('.retracted-note')?.textContent).not.toContain('typed here');
    for (const label of ['Edit', 'Link', 'Retract']) {
      expect(button(label)).toBeUndefined();
    }
  });

  it('shows the reason when a retracted chain is opened fresh', async () => {
    await open({
      ...history,
      versions: [
        history.versions[0],
        { ...history.versions[1], retracted: true, retract_reason: 'duplicate' },
      ],
    });
    expect(element.querySelector('.retracted-note')?.textContent).toContain('Reason: duplicate');
  });

  it('shows no reason for a retracted head without one', async () => {
    await open({
      ...history,
      versions: [history.versions[0], { ...history.versions[1], retracted: true }],
    });
    const note = element.querySelector('.retracted-note')?.textContent ?? '';
    expect(note).toContain('Retracted');
    expect(note).not.toContain('Reason');
  });

  it('shows a command failure once, inline, and not as a notice', async () => {
    await open();
    button('Unlink').click();
    (await request('/api/v2/commands/unlink_events')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
    expect(element.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(TestBed.inject(Notices).items()).toEqual([]);
  });

  it('clears failure, reason and relation when the mode changes', async () => {
    await open();
    button('Retract').click();
    await fixture.whenStable();
    type('reason', 'oops');
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    (await request('/api/v2/commands/retract_event')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('form [role="alert"]')).not.toBeNull();
    });
    button('Cancel').click();
    await fixture.whenStable();
    button('Retract').click();
    await fixture.whenStable();
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector<HTMLInputElement>('[name="reason"]')!.value).toBe('');
  });

  it('starts over when the router reuses the page for another chain', async () => {
    await open();
    button('Retract').click();
    await fixture.whenStable();
    type('reason', 'oops');
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    (await request('/api/v2/commands/retract_event')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('form [role="alert"]')).not.toBeNull();
    });
    fixture.componentRef.setInput('chain', 'c-2');
    (await view('c-2')).flush({ ...history, chain_id: 'c-2', links: [] });
    await settle();
    expect(element.querySelector('form')).toBeNull();
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(button('Retract')).toBeInstanceOf(HTMLButtonElement);
    expect(button('Retract').disabled).toBe(false);
    button('Retract').click();
    await fixture.whenStable();
    expect(element.querySelector<HTMLInputElement>('[name="reason"]')!.value).toBe('');
  });

  it('clears an unlink failure when the router reuses the page in view mode', async () => {
    await open();
    button('Unlink').click();
    (await request('/api/v2/commands/unlink_events')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')).not.toBeNull();
    });
    fixture.componentRef.setInput('chain', 'c-2');
    (await view('c-2')).flush({ ...history, chain_id: 'c-2', links: [] });
    await settle();
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  async function offerCandidate(): Promise<void> {
    button('Link').click();
    const [before, same] = await requests('/api/v2/views/day', 2);
    before.flush(dayView([], '2026-09-28'));
    same.flush(
      dayView([event({ id: 'lunch', chain_id: 'c-lunch', kind: 'note', payload: { text: 'x' } })]),
    );
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelectorAll('.candidates button')).toHaveLength(1);
    });
  }

  it('resets the chosen relation when the router reuses the page', async () => {
    await open();
    await offerCandidate();
    const select = element.querySelector<HTMLSelectElement>('[name="relation"]')!;
    select.value = 'part_of';
    select.dispatchEvent(new Event('change'));
    fixture.componentRef.setInput('chain', 'c-2');
    (await view('c-2')).flush({ ...history, chain_id: 'c-2', links: [] });
    await settle();
    await offerCandidate();
    expect(element.querySelector<HTMLSelectElement>('[name="relation"]')!.value).toBe(
      'suspected_cause',
    );
  });

  it('clears a failure in link mode on Cancel', async () => {
    await open();
    await offerCandidate();
    element.querySelector<HTMLButtonElement>('.candidates button')!.click();
    (await request('/api/v2/commands/link_events')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('.inline [role="alert"]')).not.toBeNull();
    });
    button('Cancel').click();
    await fixture.whenStable();
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it('recovers from a stale head with a reload and a fresh key', async () => {
    await open();
    const first = await submitRetract();
    const key = (first.request.body as { idempotency_key: string }).idempotency_key;
    first.flush(stale, { status: 409, statusText: 'Conflict' });
    const reloaded = await view('c-1');
    const newer = event({ id: 'v3', chain_id: 'c-1', kind: 'symptom', version: 3 });
    reloaded.flush({ ...history, versions: [...history.versions, newer] });
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('.history li')!.textContent).toMatch(/^v3/);
      expect(element.querySelector('form [role="alert"]')?.textContent).toContain(
        'This entry changed meanwhile; review and try again.',
      );
    });
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const second = await request('/api/v2/commands/retract_event');
    expect(second.request.body).toEqual({
      id: 'v3',
      reason: null,
      idempotency_key: expect.not.stringMatching(key),
    });
  });

  it('disables the unlink button while its command is in flight', async () => {
    await open();
    button('Unlink').click();
    const call = await request('/api/v2/commands/unlink_events');
    TestBed.tick();
    expect(button('Unlink').disabled).toBe(true);
    call.flush({});
  });

  it('unlinks an incoming link from the other chain to this one', async () => {
    await open({
      ...history,
      links: [{ chain_id: 'c-breakfast', relation: 'part_of', direction: 'incoming' }],
    });
    button('Unlink').click();
    const call = await request('/api/v2/commands/unlink_events');
    expect(call.request.body).toEqual({
      from_chain: 'c-breakfast',
      to_chain: 'c-1',
      relation: 'part_of',
      idempotency_key: expect.any(String),
    });
  });

  it('offers other entries of both days, never the event itself', async () => {
    await open();
    button('Link').click();
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.textContent).toContain('Loading');
    });
    const [before, same] = await requests('/api/v2/views/day', 2);
    expect(before.request.params.get('date')).toBe('2026-09-28');
    expect(same.request.params.get('date')).toBe('2026-09-29');
    before.flush(
      dayView(
        [
          event({
            id: 'dinner',
            chain_id: 'c-dinner',
            kind: 'note',
            local_day: '2026-09-28',
            payload: { text: 'x' },
          }),
        ],
        '2026-09-28',
      ),
    );
    same.flush(dayView([event({ id: 'v2', chain_id: 'c-1', kind: 'symptom' })]));
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelectorAll('.candidates button')).toHaveLength(1);
    });
    const candidate = element.querySelector<HTMLButtonElement>('.candidates button')!;
    expect(candidate.textContent).toContain(dayLabel('2026-09-28'));
    candidate.click();
    const call = await request('/api/v2/commands/link_events');
    TestBed.tick();
    expect(element.querySelector<HTMLButtonElement>('.candidates button')!.disabled).toBe(true);
    call.flush({});
  });

  it('says so when there is nothing to link to', async () => {
    await open();
    button('Link').click();
    const [before, same] = await requests('/api/v2/views/day', 2);
    before.flush(dayView([], '2026-09-28'));
    same.flush(dayView([]));
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.textContent).toContain('Nothing to link to');
    });
  });

  it('keeps what was typed in Edit when the history reloads with the same head', async () => {
    await open();
    button('Edit').click();
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[name="severity"]')).not.toBeNull();
    });
    type('severity', '2');
    TestBed.inject(Api).revision.update((value) => value + 1);
    (await view('c-1')).flush(structuredClone(history));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      TestBed.tick();
    });
    expect(element.querySelector<HTMLInputElement>('[name="severity"]')!.value).toBe('2');
  });
});
