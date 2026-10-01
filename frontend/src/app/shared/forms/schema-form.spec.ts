import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Notices } from '../../core/notices';
import { provideTestConfig } from '../../../testing/config';
import { payloadSchema } from '../../../testing/schemas';
import { fromLocalInput, toLocalInput } from '../time';
import { FoodPicker } from './food-picker';
import { Field, JsonSchema, formFor } from './schema';
import { SchemaForm } from './schema-form';

@Component({
  imports: [SchemaForm],
  template: `<app-schema-form
    [field]="field()"
    [(value)]="value"
    [errorPath]="errorPath()"
    errorMessage="Input should be less than or equal to 7"
  />`,
})
class Host {
  readonly field = signal<Field>(formFor(payloadSchema('outtake')));
  readonly value = signal<Record<string, unknown>>({});
  readonly errorPath = signal<string | null>(null);
}

describe('SchemaForm', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let element: HTMLElement;
  let backend: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideTestConfig(), provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    element = fixture.nativeElement;
    backend = TestBed.inject(HttpTestingController);
    await fixture.whenStable();
  });

  function input(name: string): HTMLInputElement {
    const found = element.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!found) {
      throw new Error(`no input ${name}`);
    }
    return found;
  }

  function type(name: string, text: string): void {
    const target = input(name);
    target.value = text;
    target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input'));
  }

  function click(text: string): void {
    const button = [...element.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    );
    if (!button) {
      throw new Error(`no button ${text}`);
    }
    button.click();
  }

  it.each([
    ['intake', ['slot', 'recipe_id', 'portions', 'note']],
    ['outtake', ['bristol', 'urgency', 'pain', 'note']],
    ['symptom', ['type', 'severity', 'body_area', 'note']],
    ['medication', ['name', 'dose', 'unit', 'reason', 'note']],
    ['supplement', ['name', 'dose', 'unit', 'reason', 'note']],
    ['sleep', ['quality', 'efficiency_pct', 'note']],
    ['activity', ['steps', 'active_minutes', 'distance_km']],
    ['workout', ['title', 'category', 'set_count', 'volume_kg', 'note']],
    ['measurement', ['metric', 'value', 'unit']],
    ['checkin', ['overall', 'energy', 'mood', 'stress', 'note']],
    ['note', ['text']],
  ])('renders the %s payload form', async (kind, names) => {
    host.field.set(formFor(payloadSchema(kind)));
    await fixture.whenStable();
    const rendered = [...element.querySelectorAll('[name]')].map((node) =>
      node.getAttribute('name'),
    );
    for (const name of names) {
      if (name === 'recipe_id') {
        expect(element.querySelector('app-food-picker')).not.toBeNull();
      } else {
        expect(rendered).toContain(name);
      }
    }
  });

  it('writes typed numbers, enums and multi-selects into the value', async () => {
    type('bristol', '4');
    type('note', 'after coffee');
    const mucus = [...element.querySelectorAll<HTMLLabelElement>('label.check')].find((label) =>
      label.textContent?.includes('Mucus'),
    )!;
    mucus.querySelector('input')!.click();
    await fixture.whenStable();
    expect(host.value()).toEqual({ bristol: 4, note: 'after coffee', flags: ['mucus'] });
    type('bristol', '');
    await fixture.whenStable();
    expect(host.value()['bristol']).toBeNull();
  });

  it('adds and removes array items and optional objects', async () => {
    host.field.set(formFor(payloadSchema('sleep')));
    await fixture.whenStable();
    click('Add Stages');
    await fixture.whenStable();
    type('stages.deep_min', '90');
    await fixture.whenStable();
    expect(host.value()).toEqual({
      stages: { deep_min: 90, light_min: null, rem_min: null, awake_min: null },
    });
    click('Remove Stages');
    await fixture.whenStable();
    expect(host.value()).toEqual({ stages: null });

    host.field.set(formFor(payloadSchema('workout')));
    host.value.set({});
    await fixture.whenStable();
    click('Add');
    await fixture.whenStable();
    type('exercises.0.name', 'Squat');
    await fixture.whenStable();
    expect(host.value()['exercises']).toEqual([{ name: 'Squat', category: null }]);
    click('Remove');
    await fixture.whenStable();
    expect(host.value()['exercises']).toEqual([]);
  });

  it('shows the backend error at its field', async () => {
    host.errorPath.set('bristol');
    await fixture.whenStable();
    expect(input('bristol').closest('label')!.classList).toContain('invalid');
    expect(element.querySelector('.field-error')!.textContent).toContain('less than or equal to 7');
  });

  it('picks a remote food by importing it', async () => {
    host.field.set(formFor(payloadSchema('intake')));
    await fixture.whenStable();
    click('Add');
    await fixture.whenStable();
    const search = element.querySelector<HTMLInputElement>('app-food-picker input')!;
    search.value = 'skyr';
    search.dispatchEvent(new Event('input'));
    const lookup = await vi.waitFor(() =>
      backend.expectOne((r) => r.url === '/api/v2/views/catalog' && r.params.get('q') === 'skyr'),
    );
    lookup.flush({
      local: [],
      remote: [
        { barcode: '4001234', name: 'Skyr', brand: 'Arla', per_100: { kcal: 63 }, usable: true },
      ],
      remote_error: null,
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      click('Skyr Arla · Open Food Facts');
    });
    backend.expectOne('/api/v2/commands/import_food').flush({
      result: { id: 'food-1', name: 'Skyr' },
      effects: { days: [] },
      warnings: [],
    });
    await vi.waitFor(() =>
      expect(host.value()['items']).toEqual([{ food_id: 'food-1', grams: null }]),
    );
    await fixture.whenStable();
    expect(element.querySelector('app-food-picker .chosen')!.textContent).toContain('Skyr');
  });

  it('hints an exclusive bound instead of presenting it as allowed', async () => {
    host.field.set(formFor(payloadSchema('intake')));
    await fixture.whenStable();
    click('Add');
    await fixture.whenStable();
    const grams = input('items.0.grams');
    expect(grams.getAttribute('min')).toBe('0');
    expect(grams.closest('label')!.querySelector('.bound')!.textContent).toContain('> 0');
  });

  it('applies two synchronous edits on different paths to the latest root value', () => {
    type('bristol', '5');
    type('note', 'quick');
    expect(host.value()).toEqual({ bristol: 5, note: 'quick' });
  });

  it('marks exactly the nested errorPath input invalid and links its message', async () => {
    host.field.set(formFor(payloadSchema('intake')));
    await fixture.whenStable();
    click('Add');
    await fixture.whenStable();
    host.errorPath.set('items.0.grams');
    await fixture.whenStable();
    const invalid = [...element.querySelectorAll('.invalid')];
    expect(invalid).toHaveLength(1);
    expect(invalid[0].querySelector('[name]')!.getAttribute('name')).toBe('items.0.grams');
    const grams = input('items.0.grams');
    expect(grams.getAttribute('aria-invalid')).toBe('true');
    const message = element.querySelector('.field-error')!;
    expect(grams.getAttribute('aria-describedby')).toBe(message.id);
    expect(input('portions').getAttribute('aria-invalid')).toBeNull();
    expect(element.querySelectorAll('.field-error')).toHaveLength(1);
  });

  it('names every multi-enum checkbox and keeps the picker out of a label', async () => {
    const boxes = [...element.querySelectorAll<HTMLInputElement>('label.check input')];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) => box.getAttribute('name') === 'flags')).toBe(true);
    host.field.set(formFor(payloadSchema('intake')));
    await fixture.whenStable();
    const picker = element.querySelector('app-food-picker')!;
    expect(picker.closest('label')).toBeNull();
    const group = picker.closest('[role="group"]')!;
    const label = element.querySelector(`#${group.getAttribute('aria-labelledby')}`)!;
    expect(label.textContent).toContain('Recipe');
    expect(picker.querySelector('input')!.getAttribute('name')).toBe('recipe_id');
  });
});

describe('SchemaForm dates', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      day: { type: 'string', format: 'date' },
      at: { type: 'string', format: 'date-time' },
    },
  };
  let fixture: ComponentFixture<Host>;
  let host: Host;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideTestConfig(), provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.field.set(formFor(schema));
    host.value.set({ day: '2026-09-29', at: '2026-09-29T14:30:00+02:00' });
    await fixture.whenStable();
  });

  function field(name: string): HTMLInputElement {
    return fixture.nativeElement.querySelector(`[name="${name}"]`);
  }

  function change(name: string, text: string): void {
    const target = field(name);
    target.value = text;
    target.dispatchEvent(new Event('change'));
  }

  it('renders stored values and emits edited ones through the time helpers', async () => {
    expect(field('day').value).toBe('2026-09-29');
    expect(field('at').value).toBe(toLocalInput('2026-09-29T14:30:00+02:00'));

    change('day', '2026-10-02');
    change('at', '2026-10-01T08:15');
    await fixture.whenStable();
    expect(host.value()['day']).toBe('2026-10-02');
    expect(host.value()['at']).toBe(fromLocalInput('2026-10-01T08:15'));
    expect(host.value()['at']).toMatch(/^2026-10-01T08:15:00[+-]\d{2}:\d{2}$/);

    change('day', '');
    change('at', '');
    expect(host.value()).toEqual({ day: null, at: null });
  });
});

@Component({
  imports: [FoodPicker],
  template: `@if (shown()) {
    <app-food-picker [pick]="pick()" [value]="value()" (picked)="picks.push($event)" />
  }`,
})
class PickerHost {
  readonly shown = signal(true);
  readonly pick = signal<'food' | 'recipe'>('food');
  readonly value = signal<unknown>(null);
  readonly picks: string[] = [];
}

type Sent = { url: string; params: { get(key: string): string | null } };

describe('FoodPicker', () => {
  let fixture: ComponentFixture<PickerHost>;
  let host: PickerHost;
  let element: HTMLElement;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideTestConfig(), provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(PickerHost);
    host = fixture.componentInstance;
    element = fixture.nativeElement;
    backend = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const catalog = (q: string) => (r: Sent) =>
    r.url === '/api/v2/views/catalog' && r.params.get('q') === q;

  const foodView = (id: string) => (r: Sent) =>
    r.url === '/api/v2/views/food' && r.params.get('id') === id;

  function fakeTimers(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }

  async function flushMicrotasks(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  }

  async function typeText(text: string, wait = 250): Promise<void> {
    const search = element.querySelector<HTMLInputElement>('input')!;
    search.value = text;
    search.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(wait);
    TestBed.tick();
  }

  const choiceNames = () =>
    [...element.querySelectorAll('.choices button')].map((b) =>
      b.textContent!.replace(/\s+/g, ' ').trim(),
    );

  const food = (id: string, name: string, barcode: string | null = null) => ({
    id,
    name,
    barcode,
    brand: null,
    per_100: { kcal: 100 },
  });

  const remote = (barcode: string, name: string, usable: boolean) => ({
    barcode,
    name,
    brand: null,
    per_100: { kcal: 1 },
    usable,
  });

  it('keeps the newest results when responses arrive out of order', async () => {
    fakeTimers();
    await typeText('sk');
    await typeText('sky');
    const [older] = backend.match(catalog('sk'));
    const [newer] = backend.match(catalog('sky'));
    newer.flush({ local: [food('a', 'Skyr')], remote: [], remote_error: null });
    await flushMicrotasks();
    older.flush({ local: [food('b', 'Skinny milk')], remote: [], remote_error: null });
    await flushMicrotasks();
    expect(choiceNames()).toEqual(['Skyr 100 kcal/100']);
  });

  it('discards a response that arrives after the query dropped below two characters', async () => {
    fakeTimers();
    await typeText('sky');
    const [pending] = backend.match(catalog('sky'));
    await typeText('s');
    pending.flush({ local: [food('a', 'Skyr')], remote: [], remote_error: null });
    await flushMicrotasks();
    expect(choiceNames()).toEqual([]);
  });

  it('sends one request for the last keystroke inside the debounce window', async () => {
    fakeTimers();
    await typeText('sk', 100);
    await typeText('sky', 100);
    await typeText('skyr', 249);
    expect(backend.match(() => true)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const sent = backend.match(() => true);
    expect(sent).toHaveLength(1);
    expect(sent[0].request.params.get('q')).toBe('skyr');
  });

  it('lists local foods first, drops unusable and duplicate remote hits', async () => {
    fakeTimers();
    await typeText('sk');
    backend.expectOne(catalog('sk')).flush({
      local: [food('a', 'Skyr', '111')],
      remote: [
        remote('999', 'Broken', false),
        remote('111', 'Skyr again', true),
        remote('222', 'Skyr plus', true),
      ],
      remote_error: null,
    });
    await flushMicrotasks();
    expect(choiceNames()).toEqual(['Skyr 100 kcal/100', 'Skyr plus Open Food Facts']);
  });

  it('filters recipes by name, ignoring case', async () => {
    fakeTimers();
    host.pick.set('recipe');
    fixture.detectChanges();
    await typeText('PAS');
    const recipe = (id: string, name: string) => ({ id, name, per_portion: { kcal: 400.4 } });
    backend.expectOne('/api/v2/views/recipes').flush({
      recipes: [
        recipe('1', 'Pasta bake'),
        recipe('2', 'Green salad'),
        recipe('3', 'Fusilli PASTA'),
      ],
    });
    await flushMicrotasks();
    expect(choiceNames()).toEqual([
      'Pasta bake 400 kcal/portion',
      'Fusilli PASTA 400 kcal/portion',
    ]);
  });

  it('imports a remote food once even when clicked twice', async () => {
    fakeTimers();
    await typeText('sk');
    backend.expectOne(catalog('sk')).flush({
      local: [],
      remote: [remote('222', 'Skyr', true)],
      remote_error: null,
    });
    await flushMicrotasks();
    const button = element.querySelector<HTMLButtonElement>('.choices button')!;
    button.click();
    button.click();
    await flushMicrotasks();
    backend.expectOne('/api/v2/commands/import_food').flush({
      result: { id: 'food-9', name: 'Skyr' },
      effects: { days: [] },
      warnings: [],
    });
    await flushMicrotasks();
    expect(host.picks).toEqual(['food-9']);
  });

  it('loads the name of an existing value and never shows the previous one', async () => {
    host.value.set('food-1');
    fixture.detectChanges();
    const first = backend.expectOne(foodView('food-1'));
    expect(element.querySelector('.chosen')!.textContent).toContain('…');

    host.value.set('food-2');
    fixture.detectChanges();
    const second = backend.expectOne(foodView('food-2'));
    second.flush({ id: 'food-2', name: 'Second' });
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('.chosen')!.textContent).toContain('Second');
    });
    first.flush({ id: 'food-1', name: 'First' });
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    expect(element.querySelector('.chosen')!.textContent).toContain('Second');
    expect(element.querySelector('.chosen')!.textContent).not.toContain('First');

    host.value.set('food-3');
    fixture.detectChanges();
    expect(element.querySelector('.chosen')!.textContent).not.toContain('Second');
    backend.expectOne(foodView('food-3'));

    host.value.set(null);
    fixture.detectChanges();
    expect(element.querySelector('.chosen')).toBeNull();
    expect(element.querySelector<HTMLInputElement>('input')!.value).toBe('');
  });

  it('cancels the pending search when destroyed', async () => {
    fakeTimers();
    await typeText('sky', 100);
    host.shown.set(false);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.match(() => true)).toHaveLength(0);
  });

  it('labels the search input for what it searches', () => {
    expect(element.querySelector('input')!.getAttribute('aria-label')).toBe('Search foods');
    host.pick.set('recipe');
    fixture.detectChanges();
    expect(element.querySelector('input')!.getAttribute('aria-label')).toBe('Search recipes');
  });

  it('sends an idempotency key with the import and shows its warnings', async () => {
    fakeTimers();
    await typeText('sk');
    backend.expectOne(catalog('sk')).flush({
      local: [],
      remote: [remote('222', 'Skyr', true)],
      remote_error: null,
    });
    await flushMicrotasks();
    element.querySelector<HTMLButtonElement>('.choices button')!.click();
    await flushMicrotasks();
    const call = backend.expectOne('/api/v2/commands/import_food');
    expect(call.request.body).toEqual({ barcode: '222', idempotency_key: expect.any(String) });
    call.flush({
      result: { id: 'food-9', name: 'Skyr' },
      effects: { days: [] },
      warnings: ['Salt looks high'],
    });
    await flushMicrotasks();
    expect(
      TestBed.inject(Notices)
        .items()
        .map((n) => n.text),
    ).toEqual(['Salt looks high']);
  });

  it('keeps the name of a just-picked food instead of reloading it', async () => {
    fakeTimers();
    await typeText('sk');
    backend.expectOne(catalog('sk')).flush({
      local: [],
      remote: [remote('222', 'Skyr', true)],
      remote_error: null,
    });
    await flushMicrotasks();
    element.querySelector<HTMLButtonElement>('.choices button')!.click();
    await flushMicrotasks();
    backend.expectOne('/api/v2/commands/import_food').flush({
      result: { id: 'food-9', name: 'Skyr' },
      effects: { days: [] },
      warnings: [],
    });
    await flushMicrotasks();
    host.value.set('food-9');
    fixture.detectChanges();
    await flushMicrotasks();
    backend.expectNone(foodView('food-9'));
    expect(element.querySelector('.chosen')!.textContent).toContain('Skyr');
    expect(element.querySelector('.chosen')!.textContent).not.toContain('food-9');
  });
});
