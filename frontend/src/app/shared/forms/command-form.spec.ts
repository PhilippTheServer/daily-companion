import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideFeatureTesting, request } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import type { CommandName } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { CommandForm } from './command-form';
import { JsonSchema, formFor } from './schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAVE_FOOD = '/api/v2/commands/save_food';
const COMMANDS = ['save_food', 'save_recipe', 'set_source_preference', 'update_profile'] as const;

describe('CommandForm', () => {
  let fixture: ComponentFixture<CommandForm>;
  let element: HTMLElement;
  let results: unknown[];

  async function open(
    command: CommandName,
    inputs: Record<string, unknown> = {},
    ready = '[name="name"]',
  ): Promise<void> {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(CommandForm);
    fixture.componentRef.setInput('command', command);
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    results = [];
    fixture.componentInstance.done.subscribe((result) => results.push(result));
    element = fixture.nativeElement;
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector(ready)).not.toBeNull();
    });
  }

  function fill(name: string, value: string): void {
    const target = element.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    target.value = value;
    target.dispatchEvent(new Event('input'));
  }

  function submit(): void {
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
  }

  async function failed(): Promise<void> {
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('.form-error')).not.toBeNull();
    });
  }

  function sent(url: string): number {
    TestBed.tick();
    return TestBed.inject(HttpTestingController).match(url).length;
  }

  const saved = { result: { id: 'food-1' }, effects: { days: [] }, warnings: [] };

  it('sends the cleaned form plus the fixed values and emits the result', async () => {
    await open('save_food', {
      fixed: { id: 'food-1' },
      initial: {
        name: 'Skyr',
        brand: 'Arla',
        kind: 'food',
        per_100: { kcal: 63, protein_g: 11 },
        versions: 2,
      },
    });
    expect(element.querySelector('[name="id"]')).toBeNull();
    fill('brand', '');
    submit();
    const call = await request(SAVE_FOOD);
    expect(call.request.body).toEqual({
      id: 'food-1',
      name: 'Skyr',
      brand: null,
      kind: 'food',
      unit_name: null,
      unit_grams: null,
      pack_grams: null,
      per_100: {
        kcal: 63,
        protein_g: 11,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        sugar_g: null,
        salt_g: null,
      },
      idempotency_key: expect.stringMatching(UUID),
    });
    call.flush(saved);
    await vi.waitFor(() => expect(results).toEqual([{ id: 'food-1' }]));
  });

  it('hides and does not send an omitted key', async () => {
    await open('save_food', { omit: ['brand'], initial: { name: 'Skyr', brand: 'Arla' } });
    expect(element.querySelector('[name="brand"]')).toBeNull();
    submit();
    const call = await request(SAVE_FOOD);
    expect(call.request.body).not.toHaveProperty('brand');
  });

  it('passes the response warnings to the notices', async () => {
    await open('save_food');
    const warnings = vi.spyOn(TestBed.inject(Notices), 'warnings');
    submit();
    (await request(SAVE_FOOD)).flush({ ...saved, warnings: ['heads up'] });
    await vi.waitFor(() => expect(warnings).toHaveBeenCalledWith(['heads up']));
  });

  it('marks the failing field, announces it and enables Save again', async () => {
    await open('save_food');
    submit();
    (await request(SAVE_FOOD)).flush(
      { code: 'validation', message: 'Nope', field: 'name' },
      { status: 422, statusText: 'Unprocessable' },
    );
    await failed();
    expect(element.querySelector('[name="name"]')!.getAttribute('aria-invalid')).toBe('true');
    expect(element.querySelector('.form-error')!.getAttribute('role')).toBe('alert');
    expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it('shows a message for a network failure', async () => {
    await open('save_food');
    submit();
    (await request(SAVE_FOOD)).error(new ProgressEvent('error'));
    await failed();
    expect(element.querySelector('.form-error')!.textContent).toContain(
      'The server cannot be reached',
    );
  });

  it('shows a form error and Cancel for an unknown command', async () => {
    await open('nonsense' as CommandName, {}, '.form-error');
    let cancelled = 0;
    fixture.componentInstance.cancelled.subscribe(() => cancelled++);
    element.querySelector<HTMLButtonElement>('button')!.click();
    expect(cancelled).toBe(1);
  });

  it('does not show a subscriber exception as a save failure', async () => {
    await open('save_food');
    fixture.componentInstance.done.subscribe(() => {
      throw new Error('boom');
    });
    submit();
    (await request(SAVE_FOOD)).flush(saved);
    await vi.waitFor(() => expect(results).toHaveLength(1));
    await fixture.whenStable();
    expect(element.querySelector('.form-error')).toBeNull();
  });

  describe('idempotency', () => {
    it('ignores a second submit while busy', async () => {
      await open('save_food');
      submit();
      const call = await request(SAVE_FOOD);
      submit();
      expect(sent(SAVE_FOOD)).toBe(0);
      call.flush(saved);
      await vi.waitFor(() => expect(results).toHaveLength(1));
    });

    it('retries a failed request with the same key, then uses a fresh one', async () => {
      await open('save_food');
      submit();
      const first = await request(SAVE_FOOD);
      const key = first.request.body.idempotency_key;
      expect(key).toMatch(UUID);
      first.error(new ProgressEvent('error'));
      await failed();
      submit();
      const retry = await request(SAVE_FOOD);
      expect(retry.request.body.idempotency_key).toBe(key);
      retry.flush(saved);
      await vi.waitFor(() => expect(results).toHaveLength(1));
      submit();
      const next = await request(SAVE_FOOD);
      expect(next.request.body.idempotency_key).toMatch(UUID);
      expect(next.request.body.idempotency_key).not.toBe(key);
    });

    it('renews the key when the body was edited after a failure', async () => {
      await open('save_food', { initial: { name: 'A' } });
      submit();
      const first = await request(SAVE_FOOD);
      first.error(new ProgressEvent('error'));
      await failed();
      fill('name', 'B');
      submit();
      const edited = await request(SAVE_FOOD);
      expect(edited.request.body.name).toBe('B');
      expect(edited.request.body.idempotency_key).not.toBe(first.request.body.idempotency_key);
      edited.error(new ProgressEvent('error'));
      await failed();
      submit();
      const same = await request(SAVE_FOOD);
      expect(same.request.body.idempotency_key).toBe(edited.request.body.idempotency_key);
    });

    it('renews the key when the initial value changes', async () => {
      await open('save_food', { initial: { name: 'A' } });
      submit();
      const first = await request(SAVE_FOOD);
      first.error(new ProgressEvent('error'));
      await failed();
      fixture.componentRef.setInput('initial', { name: 'B' });
      await fixture.whenStable();
      submit();
      const other = await request(SAVE_FOOD);
      expect(other.request.body.name).toBe('B');
      expect(other.request.body.idempotency_key).not.toBe(first.request.body.idempotency_key);
    });
  });

  describe('changing inputs on the same instance', () => {
    it('resets the value and the error when initial changes', async () => {
      await open('save_food', { initial: { name: 'A' } });
      submit();
      (await request(SAVE_FOOD)).flush(
        { code: 'validation', message: 'Nope', field: 'name' },
        { status: 422, statusText: 'Unprocessable' },
      );
      await failed();
      fixture.componentRef.setInput('initial', { name: 'B' });
      await fixture.whenStable();
      expect(element.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('B');
      expect(element.querySelector('.form-error')).toBeNull();
    });

    it('resets the value when the command changes', async () => {
      await open('save_food', { initial: { name: 'A' } });
      fixture.componentRef.setInput('command', 'save_recipe');
      fixture.componentRef.setInput('initial', { name: 'Soup' });
      await fixture.whenStable();
      submit();
      const call = await request('/api/v2/commands/save_recipe');
      expect(call.request.body.name).toBe('Soup');
    });
  });

  it.each(COMMANDS)('builds a form for %s from the snapshot', (command) => {
    const schema = (SCHEMAS.commands as Record<string, unknown>)[command] as JsonSchema;
    expect(() => formFor(schema)).not.toThrow();
  });

  it('shows a form error and Cancel without throwing when the schemas request fails', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const view = TestBed.createComponent(CommandForm);
    view.componentRef.setInput('command', 'save_food');
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
