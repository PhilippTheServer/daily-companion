import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import type { EventOut } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { EventEditor, ENDS, editablePayload } from './event-editor';
import { JsonSchema, formFor } from './schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OK = { effects: { days: [] }, warnings: [] };

describe('EventEditor', () => {
  let fixture: ComponentFixture<EventEditor>;
  let element: HTMLElement;
  let saved: EventOut[];

  async function open(kind: string, existing: EventOut | null = null): Promise<void> {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(EventEditor);
    fixture.componentRef.setInput('kind', kind);
    fixture.componentRef.setInput('event', existing);
    saved = [];
    fixture.componentInstance.saved.subscribe((value) => saved.push(value));
    element = fixture.nativeElement;
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('form')).not.toBeNull();
    });
  }

  function fill(name: string, value: string): void {
    const target = element.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    target.value = value;
    target.dispatchEvent(
      new Event(
        target.tagName === 'SELECT' || target.type === 'datetime-local' ? 'change' : 'input',
      ),
    );
  }

  async function fail(url: string, field: string | null, status = 422): Promise<void> {
    (await request(url)).flush(
      { code: 'validation', message: 'Nope', field },
      { status, statusText: 'Unprocessable' },
    );
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('.form-error')).not.toBeNull();
    });
  }

  function invalid(name: string): boolean {
    return element.querySelector(`[name="${name}"]`)!.getAttribute('aria-invalid') === 'true';
  }

  function sent(url: string): number {
    TestBed.tick();
    return TestBed.inject(HttpTestingController).match(url).length;
  }

  async function submit(): Promise<void> {
    await fixture.whenStable();
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
  }

  it('logs a new symptom with log_events', async () => {
    await open('symptom');
    fill('occurred_at', '2026-09-29T14:00');
    fill('type', 'bloated');
    fill('severity', '3');
    await submit();
    const call = await request('/api/v2/commands/log_events');
    const draft = call.request.body.events[0];
    expect(draft).toMatchObject({
      kind: 'symptom',
      payload: { type: 'bloated', severity: 3, body_area: null, note: null },
    });
    expect(draft.occurred_at).toMatch(/^2026-09-29T14:00:00[+-]\d\d:\d\d$/);
    expect(draft).not.toHaveProperty('ends_at');
    expect(call.request.body.idempotency_key).toMatch(UUID);
    const created = event({ kind: 'symptom' });
    call.flush({ result: { events: [created] }, effects: { days: ['2026-09-29'] }, warnings: [] });
    await vi.waitFor(() => expect(saved).toEqual([created]));
  });

  it('shows a validation error at its field', async () => {
    await open('outtake');
    fill('bristol', '9');
    await submit();
    (await request('/api/v2/commands/log_events')).flush(
      {
        code: 'validation',
        message: 'Input should be less than or equal to 7',
        field: 'events.0.payload.bristol',
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[name="bristol"]')!.closest('label')!.classList).toContain(
        'invalid',
      );
    });
    const input = element.querySelector('[name="bristol"]')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(saved).toEqual([]);
  });

  it('corrects an existing event with correct_event and the whole payload', async () => {
    const head = event({ id: 'head-2', kind: 'note', version: 2, payload: { text: 'old' } });
    await open('note', head);
    expect(element.querySelector('h2')!.textContent).toContain('Edit note');
    fill('text', 'new text');
    await submit();
    const call = await request('/api/v2/commands/correct_event');
    expect(call.request.body).toEqual({
      id: 'head-2',
      occurred_at: head.occurred_at,
      ends_at: null,
      payload: { text: 'new text' },
      idempotency_key: expect.stringMatching(UUID),
    });
    call.flush({
      result: { ...head, id: 'head-3', version: 3 },
      effects: { days: [] },
      warnings: [],
    });
    await vi.waitFor(() => expect(saved[0].id).toBe('head-3'));
  });

  describe('end time', () => {
    it.each(['sleep', 'activity'] as const)(
      '%s requires an End and sends ends_at',
      async (kind) => {
        await open(kind);
        expect(element.querySelector<HTMLInputElement>('[name="ends_at"]')!.required).toBe(true);
        fill('occurred_at', '2026-09-29T22:00');
        fill('ends_at', '2026-09-30T06:30');
        await submit();
        const call = await request('/api/v2/commands/log_events');
        expect(call.request.body.events[0].ends_at).toMatch(/^2026-09-30T06:30:00[+-]\d\d:\d\d$/);
      },
    );

    it.each(['symptom', 'workout'] as const)('%s has an optional End', async (kind) => {
      await open(kind);
      expect(element.querySelector<HTMLInputElement>('[name="ends_at"]')!.required).toBe(false);
      await submit();
      const call = await request('/api/v2/commands/log_events');
      expect(call.request.body.events[0]).not.toHaveProperty('ends_at');
    });

    it('note has no End input and sends no ends_at when logging', async () => {
      await open('note');
      expect(element.querySelector('[name="ends_at"]')).toBeNull();
      await submit();
      const call = await request('/api/v2/commands/log_events');
      expect(call.request.body.events[0]).not.toHaveProperty('ends_at');
    });

    it('note sends ends_at null when correcting', async () => {
      await open('note', event({ ends_at: '2026-09-29T09:00:00Z' }));
      expect(element.querySelector('[name="ends_at"]')).toBeNull();
      await submit();
      const call = await request('/api/v2/commands/correct_event');
      expect(call.request.body.ends_at).toBeNull();
    });
  });

  describe('error mapping', () => {
    const sleep = event({ kind: 'sleep', ends_at: '2026-09-29T07:00:00Z', payload: {} });

    it('marks the payload field when correcting', async () => {
      await open('note', event());
      await submit();
      await fail('/api/v2/commands/correct_event', 'payload.text');
      expect(invalid('text')).toBe(true);
      expect(invalid('occurred_at')).toBe(false);
    });

    it.each(['ends_at', 'occurred_at'])('marks the %s input when correcting', async (field) => {
      await open('sleep', sleep);
      await submit();
      await fail('/api/v2/commands/correct_event', field);
      expect(invalid(field)).toBe(true);
      const message = element.querySelector('.form-error')!;
      expect(element.querySelector(`[name="${field}"]`)!.getAttribute('aria-describedby')).toBe(
        message.id,
      );
    });

    it('marks the End input for events.0.ends_at when logging', async () => {
      await open('sleep');
      await submit();
      await fail('/api/v2/commands/log_events', 'events.0.ends_at');
      expect(invalid('ends_at')).toBe(true);
      expect(invalid('occurred_at')).toBe(false);
    });

    it('announces the error and shows the required marker', async () => {
      await open('sleep');
      expect(
        element.querySelector('label:has([name="occurred_at"]) b[aria-hidden]'),
      ).not.toBeNull();
      expect(element.querySelector('label:has([name="ends_at"]) b[aria-hidden]')).not.toBeNull();
      await submit();
      await fail('/api/v2/commands/log_events', null);
      expect(element.querySelector('.form-error')!.getAttribute('role')).toBe('alert');
    });
  });

  describe('failures', () => {
    it('enables Save again after an error', async () => {
      await open('note');
      await submit();
      await fail('/api/v2/commands/log_events', null);
      expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
        false,
      );
    });

    it('shows a message for a network failure', async () => {
      await open('note');
      await submit();
      (await request('/api/v2/commands/log_events')).error(new ProgressEvent('error'));
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(element.querySelector('.form-error')!.textContent).toContain(
          'The server cannot be reached',
        );
      });
    });

    it('shows a form error and Cancel for a kind without a schema', async () => {
      TestBed.configureTestingModule({ providers: provideFeatureTesting() });
      fixture = TestBed.createComponent(EventEditor);
      fixture.componentRef.setInput('kind', 'bogus');
      element = fixture.nativeElement;
      let cancelled = 0;
      fixture.componentInstance.cancelled.subscribe(() => cancelled++);
      (await request('/api/v2/schemas')).flush(SCHEMAS);
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(element.querySelector('.form-error')).not.toBeNull();
      });
      element.querySelector<HTMLButtonElement>('button')!.click();
      expect(cancelled).toBe(1);
    });

    it('does not show a subscriber exception as a save failure', async () => {
      await open('note');
      fixture.componentInstance.saved.subscribe(() => {
        throw new Error('boom');
      });
      await submit();
      (await request('/api/v2/commands/log_events')).flush({
        result: { events: [event()] },
        ...OK,
      });
      await vi.waitFor(() => expect(saved).toHaveLength(1));
      await fixture.whenStable();
      expect(element.querySelector('.form-error')).toBeNull();
    });
  });

  it('passes the response warnings to the notices', async () => {
    await open('note');
    const warnings = vi.spyOn(TestBed.inject(Notices), 'warnings');
    await submit();
    (await request('/api/v2/commands/log_events')).flush({
      result: { events: [event()] },
      effects: { days: [] },
      warnings: ['heads up'],
    });
    await vi.waitFor(() => expect(warnings).toHaveBeenCalledWith(['heads up']));
  });

  describe('idempotency', () => {
    const created = { result: { events: [event()] }, ...OK };

    it('ignores a second submit while busy', async () => {
      await open('note');
      await submit();
      const call = await request('/api/v2/commands/log_events');
      element.querySelector('form')!.dispatchEvent(new Event('submit'));
      expect(sent('/api/v2/commands/log_events')).toBe(0);
      call.flush(created);
      await vi.waitFor(() => expect(saved).toHaveLength(1));
    });

    it('retries a failed request with the same key, then uses a fresh one', async () => {
      await open('note');
      await submit();
      const first = await request('/api/v2/commands/log_events');
      const key = first.request.body.idempotency_key;
      expect(key).toMatch(UUID);
      first.error(new ProgressEvent('error'));
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(element.querySelector('.form-error')).not.toBeNull();
      });
      await submit();
      const retry = await request('/api/v2/commands/log_events');
      expect(retry.request.body.idempotency_key).toBe(key);
      retry.flush(created);
      await vi.waitFor(() => expect(saved).toHaveLength(1));
      await submit();
      const next = await request('/api/v2/commands/log_events');
      expect(next.request.body.idempotency_key).toMatch(UUID);
      expect(next.request.body.idempotency_key).not.toBe(key);
    });

    it('renews the key when the body was edited after a failure', async () => {
      await open('note');
      fill('text', 'one');
      await submit();
      const first = await request('/api/v2/commands/log_events');
      first.error(new ProgressEvent('error'));
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(element.querySelector('.form-error')).not.toBeNull();
      });
      fill('text', 'two');
      await submit();
      const edited = await request('/api/v2/commands/log_events');
      expect(edited.request.body.idempotency_key).not.toBe(first.request.body.idempotency_key);
      edited.error(new ProgressEvent('error'));
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(element.querySelector('.form-error')).not.toBeNull();
      });
      await submit();
      const same = await request('/api/v2/commands/log_events');
      expect(same.request.body.idempotency_key).toBe(edited.request.body.idempotency_key);
    });

    it('sends a key with correct_event and renews it for another event', async () => {
      const head = event({ id: 'h-1' });
      await open('note', head);
      await submit();
      const first = await request('/api/v2/commands/correct_event');
      const key = first.request.body.idempotency_key;
      expect(key).toMatch(UUID);
      first.error(new ProgressEvent('error'));
      await vi.waitFor(async () => {
        await fixture.whenStable();
        expect(element.querySelector('.form-error')).not.toBeNull();
      });
      fixture.componentRef.setInput('event', event({ id: 'h-2' }));
      await fixture.whenStable();
      await submit();
      const other = await request('/api/v2/commands/correct_event');
      expect(other.request.body.id).toBe('h-2');
      expect(other.request.body.idempotency_key).not.toBe(key);
    });
  });

  describe('changing inputs on the same instance', () => {
    it('resets payload, times and error for another event', async () => {
      const sleepEvent = event({
        id: 's-1',
        kind: 'note',
        occurred_at: '2026-09-29T08:00:00Z',
        payload: { text: 'first' },
      });
      await open('note', sleepEvent);
      await submit();
      await fail('/api/v2/commands/correct_event', 'payload.text');
      fixture.componentRef.setInput(
        'event',
        event({ id: 's-2', occurred_at: '2026-09-28T10:00:00Z', payload: { text: 'second' } }),
      );
      await fixture.whenStable();
      expect(element.querySelector<HTMLTextAreaElement>('[name="text"]')!.value).toBe('second');
      expect(element.querySelector('.form-error')).toBeNull();
      await submit();
      const call = await request('/api/v2/commands/correct_event');
      expect(call.request.body).toMatchObject({
        id: 's-2',
        occurred_at: '2026-09-28T10:00:00Z',
        payload: { text: 'second' },
      });
    });

    it('resets to a blank draft when the kind changes', async () => {
      await open('note');
      fill('text', 'typed');
      fixture.componentRef.setInput('kind', 'symptom');
      await fixture.whenStable();
      fill('severity', '2');
      await submit();
      const call = await request('/api/v2/commands/log_events');
      expect(call.request.body.events[0].kind).toBe('symptom');
      expect(call.request.body.events[0].payload).not.toHaveProperty('text');
    });
  });

  it('omits the recipe items when editing a recipe intake', async () => {
    const head = event({
      kind: 'intake',
      payload: { recipe_id: 'r1', portions: 2, items: [{ food_id: 'f1', grams: 100 }] },
    });
    await open('intake', head);
    await submit();
    const call = await request('/api/v2/commands/correct_event');
    expect(call.request.body.payload).toMatchObject({ recipe_id: 'r1', portions: 2, items: [] });
  });
});

describe('payload schemas', () => {
  it.each(Object.keys(SCHEMAS.payloads))('builds a form for %s', (kind) => {
    const schema = (SCHEMAS.payloads as Record<string, unknown>)[kind] as JsonSchema;
    expect(formFor(schema).fields.length).toBeGreaterThan(0);
    expect(Object.keys(ENDS)).toContain(kind);
  });
});

describe('editablePayload', () => {
  it('edits a recipe intake as the recipe, not its resolved items', () => {
    const stored = event({
      kind: 'intake',
      payload: { recipe_id: 'r1', portions: 2, items: [{ food_id: 'f1', grams: 100 }] },
    });
    expect(editablePayload(stored)).toEqual({ recipe_id: 'r1', portions: 2, items: [] });
  });

  it('shows a form error and Cancel without throwing when the schemas request fails', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const view = TestBed.createComponent(EventEditor);
    view.componentRef.setInput('kind', 'note');
    const host: HTMLElement = view.nativeElement;
    let cancelled = 0;
    view.componentInstance.cancelled.subscribe(() => cancelled++);
    (await request('/api/v2/schemas')).flush(
      { message: 'boom' },
      { status: 500, statusText: 'Server Error' },
    );
    await vi.waitFor(async () => {
      await view.whenStable();
      expect(host.querySelector('.form-error')).not.toBeNull();
    });
    expect(host.querySelector('form')).toBeNull();
    host.querySelector<HTMLButtonElement>('button')!.click();
    expect(cancelled).toBe(1);
  });
});
