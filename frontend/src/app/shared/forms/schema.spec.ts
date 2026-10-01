import { SCHEMAS, commandSchema, payloadSchema } from '../../../testing/schemas';
import {
  Field,
  JsonSchema,
  clean,
  fieldUnder,
  formFor,
  initialValue,
  labelFor,
  toField,
  updateIn,
} from './schema';

function child(field: Field, key: string): Field {
  const found = field.fields.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no field ${key}`);
  }
  return found;
}

describe('formFor', () => {
  it.each(Object.keys(SCHEMAS.payloads))('builds a form for the %s payload', (kind) => {
    const form = formFor(payloadSchema(kind));
    expect(form.widget).toBe('object');
    expect(form.fields.length).toBeGreaterThan(0);
  });

  it.each(['update_profile', 'set_source_preference', 'save_food', 'save_recipe', 'import_food'])(
    'builds a form for the %s command without the idempotency key',
    (name) => {
      const form = formFor(commandSchema(name), ['id']);
      expect(form.fields.map((field) => field.key)).not.toContain('idempotency_key');
      expect(form.fields.map((field) => field.key)).not.toContain('id');
    },
  );

  it('maps the intake payload to pickers, an item list and a text note', () => {
    const intake = formFor(payloadSchema('intake'));
    expect(child(intake, 'slot')).toMatchObject({
      widget: 'enum',
      nullable: true,
      options: ['breakfast', 'lunch', 'dinner', 'snack'],
    });
    const items = child(intake, 'items');
    expect(items.widget).toBe('array');
    expect(items.maxItems).toBe(60);
    expect(child(items.item!, 'food_id')).toMatchObject({ widget: 'food-picker', pick: 'food' });
    expect(child(items.item!, 'grams')).toMatchObject({
      widget: 'number',
      required: true,
      max: 5000,
    });
    expect(child(intake, 'recipe_id')).toMatchObject({ widget: 'food-picker', pick: 'recipe' });
    expect(child(intake, 'note').widget).toBe('text');
  });

  it('maps booleans, integers, multi-selects and nullable objects', () => {
    const outtake = formFor(payloadSchema('outtake'));
    expect(child(outtake, 'bristol')).toMatchObject({
      widget: 'integer',
      min: 1,
      max: 7,
      required: true,
    });
    expect(child(outtake, 'urgency').widget).toBe('boolean');
    expect(child(outtake, 'flags')).toMatchObject({ widget: 'multi-enum' });
    expect(child(outtake, 'flags').item!.options).toEqual(['blood', 'mucus', 'undigested']);
    const stages = child(formFor(payloadSchema('sleep')), 'stages');
    expect(stages).toMatchObject({ widget: 'object', nullable: true });
    expect(stages.fields.map((field) => field.label)).toEqual([
      'Deep (min)',
      'Light (min)',
      'Rem (min)',
      'Awake (min)',
    ]);
  });

  it('maps dates and nested exercise sets', () => {
    expect(child(formFor(commandSchema('update_profile')), 'goal_date').widget).toBe('date');
    const exercises = child(formFor(payloadSchema('workout')), 'exercises');
    expect(child(exercises.item!, 'sets').item!.fields.map((field) => field.key)).toEqual([
      'reps',
      'weight_kg',
      'duration_s',
      'rpe',
    ]);
  });
});

describe('labelFor', () => {
  it('puts units in brackets', () => {
    expect(labelFor('goal_weight_kg')).toBe('Goal weight (kg)');
    expect(labelFor('fat_g_per_kg_min')).toBe('Fat (g/kg, minimum)');
    expect(labelFor('efficiency_pct')).toBe('Efficiency (%)');
    expect(labelFor('body_area')).toBe('Body area');
    expect(labelFor('food_id')).toBe('Food');
  });
});

describe('initialValue and clean', () => {
  it('starts a recipe with its defaults', () => {
    expect(initialValue(formFor(commandSchema('save_recipe'), ['id']))).toEqual({
      name: null,
      serves: 1,
      items: [],
    });
  });

  it('keeps only schema keys, so a stored intake can be sent back', () => {
    const intake = formFor(payloadSchema('intake'));
    const stored = {
      slot: 'breakfast',
      items: [{ food_id: 'f1', food_version_id: 'v1', name: 'Oats', grams: 80, nutrients: {} }],
      recipe_id: null,
      recipe_version_id: null,
      portions: null,
      note: '',
      nutrients: { kcal: 300 },
    };
    expect(clean(intake, stored)).toEqual({
      slot: 'breakfast',
      items: [{ food_id: 'f1', grams: 80 }],
      recipe_id: null,
      portions: null,
      note: null,
    });
  });

  it('leaves out an empty required input so the backend names it', () => {
    expect(clean(formFor(payloadSchema('outtake')), { bristol: null, flags: ['mucus'] })).toEqual({
      urgency: null,
      pain: null,
      flags: ['mucus'],
      note: null,
    });
  });
});

describe('fieldUnder', () => {
  it('strips the form prefix from an error path', () => {
    expect(fieldUnder('events.0.payload.items.0.grams', 'events.0.payload')).toBe('items.0.grams');
    expect(fieldUnder('events.0.occurred_at', 'events.0.payload')).toBeNull();
    expect(fieldUnder('name', '')).toBe('name');
    expect(fieldUnder(null, '')).toBeNull();
  });
});

describe('updateIn', () => {
  it('replaces a nested value without touching the original', () => {
    const root = { items: [{ food_id: 'a', grams: 1 }], note: 'x' };
    const next = updateIn(root, ['items', 0, 'grams'], () => 80);
    expect(next).toEqual({ items: [{ food_id: 'a', grams: 80 }], note: 'x' });
    expect(root.items[0].grams).toBe(1);
    expect(updateIn(undefined, ['stages', 'deep_min'], () => 5)).toEqual({
      stages: { deep_min: 5 },
    });
  });
});

describe('bounds', () => {
  it('flags exclusive bounds and leaves inclusive ones alone', () => {
    const intake = formFor(payloadSchema('intake'));
    const grams = child(child(intake, 'items').item!, 'grams');
    expect(grams).toMatchObject({ min: 0, exclusiveMin: true, max: 5000 });
    expect(grams.exclusiveMax).toBeFalsy();
    const bristol = child(formFor(payloadSchema('outtake')), 'bristol');
    expect(bristol).toMatchObject({ min: 1, max: 7 });
    expect(bristol.exclusiveMin).toBeFalsy();
  });

  it('flags both exclusive ends of the profile height', () => {
    const height = child(formFor(commandSchema('update_profile')), 'height_cm');
    expect(height).toMatchObject({
      min: 50,
      exclusiveMin: true,
      max: 260,
      exclusiveMax: true,
    });
  });
});

describe('unsupported schemas', () => {
  it('refuses a free-form object instead of dropping its value', () => {
    expect(() => formFor(commandSchema('correct_event'))).toThrow(/free-form.*payload/);
  });

  it('names the oneOf union and its path', () => {
    expect(() => formFor(commandSchema('log_events'))).toThrow(/oneOf.*events\[\]/);
  });

  it('throws on an unresolved reference', () => {
    expect(() => toField({ $ref: '#/$defs/Missing' })).toThrow(/Missing/);
  });

  it('throws on a union of two non-null variants', () => {
    const union: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(() => toField(union, union, 'either')).toThrow(/either/);
  });

  it('throws on an unknown type', () => {
    expect(() => toField({ type: 'tuple' }, undefined, 'pair')).toThrow(/pair/);
  });
});

describe('$ref siblings', () => {
  it('lets the outer default and description win over the target', () => {
    const schema: JsonSchema = {
      $defs: { Mode: { type: 'string', enum: ['a', 'b'], description: 'inner' } },
      properties: { mode: { $ref: '#/$defs/Mode', default: 'b', description: 'outer' } },
      type: 'object',
    };
    expect(child(formFor(schema), 'mode')).toMatchObject({
      widget: 'enum',
      options: ['a', 'b'],
      initial: 'b',
      hint: 'outer',
    });
  });
});
