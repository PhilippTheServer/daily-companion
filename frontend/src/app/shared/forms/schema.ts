/** The subset of JSON Schema (as pydantic writes it) that the form renderer reads. */
export interface JsonSchema {
  type?: string;
  format?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  maxLength?: number;
  pattern?: string;
  maxItems?: number;
}

export type Widget =
  | 'number'
  | 'integer'
  | 'string'
  | 'text'
  | 'enum'
  | 'boolean'
  | 'date-time'
  | 'date'
  | 'object'
  | 'array'
  | 'multi-enum'
  | 'food-picker';

/** One input of a generated form; objects and arrays nest further fields. */
export interface Field {
  key: string;
  label: string;
  hint: string | null;
  widget: Widget;
  required: boolean;
  nullable: boolean;
  options: string[];
  min: number | null;
  max: number | null;
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
  maxLength: number | null;
  pattern: string | null;
  maxItems: number | null;
  initial: unknown;
  fields: Field[];
  item: Field | null;
  pick: 'food' | 'recipe' | null;
}

const TEXT_FROM_LENGTH = 500;
const ALWAYS_HIDDEN = ['idempotency_key'];
const UNIT_SUFFIXES: [string, string][] = [
  ['_g_per_kg_min', 'g/kg, minimum'],
  ['_g_per_kg', 'g/kg'],
  ['_kg', 'kg'],
  ['_g', 'g'],
  ['_ml', 'ml'],
  ['_cm', 'cm'],
  ['_km', 'km'],
  ['_min', 'min'],
  ['_pct', '%'],
  ['_bpm', 'bpm'],
  ['_s', 's'],
];

/** "stomach_ache" → "Stomach ache". */
export function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A property name as a label: units in brackets ("goal_weight_kg" → "Goal weight (kg)"), no "id". */
export function labelFor(key: string): string {
  if (key.endsWith('_id')) {
    return humanize(key.slice(0, -3));
  }
  for (const [suffix, unit] of UNIT_SUFFIXES) {
    if (key.endsWith(suffix) && key.length > suffix.length) {
      return `${humanize(key.slice(0, -suffix.length))} (${unit})`;
    }
  }
  return humanize(key);
}

function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) {
    return schema;
  }
  const name = schema.$ref.replace('#/$defs/', '');
  const target = root.$defs?.[name];
  if (!target) {
    throw new Error(`unresolved schema reference ${schema.$ref}`);
  }
  const { $ref: _ref, ...siblings } = schema;
  return { ...target, ...siblings };
}

function widgetFor(key: string, path: string, schema: JsonSchema, item: Field | null): Widget {
  if (key === 'food_id' || key === 'recipe_id') {
    return 'food-picker';
  }
  if (schema.enum) {
    return 'enum';
  }
  switch (schema.type) {
    case 'boolean':
    case 'integer':
    case 'number':
    case 'object':
      return schema.type;
    case 'array':
      return item?.widget === 'enum' ? 'multi-enum' : 'array';
    case 'string':
      if (schema.format === 'date-time' || schema.format === 'date') {
        return schema.format;
      }
      return (schema.maxLength ?? 0) >= TEXT_FROM_LENGTH ? 'text' : 'string';
  }
  throw new Error(`no form widget for "${path}" (${JSON.stringify(schema).slice(0, 80)})`);
}

function build(
  schema: JsonSchema,
  root: JsonSchema,
  key: string,
  required: boolean,
  path: string,
): Field {
  const outer = resolve(schema, root);
  if (outer.oneOf) {
    throw new Error(`no form widget for the oneOf union at "${path}"`);
  }
  const variants = outer.anyOf?.filter((variant) => variant.type !== 'null');
  if (variants && variants.length !== 1) {
    throw new Error(`no form widget for the union at "${path}"`);
  }
  const inner = variants ? resolve(variants[0], root) : outer;
  if (inner.type === 'object' && !inner.properties) {
    throw new Error(`free-form objects are not supported ("${path}")`);
  }
  const item =
    inner.type === 'array' && inner.items ? build(inner.items, root, '', true, `${path}[]`) : null;
  const requiredKeys = inner.required ?? [];
  const fields = Object.entries(inner.properties ?? {})
    .filter(([name]) => !ALWAYS_HIDDEN.includes(name))
    .map(([name, child]) =>
      build(child, root, name, requiredKeys.includes(name), path ? `${path}.${name}` : name),
    );
  const widget = widgetFor(key, path, inner, item);
  return {
    key,
    label: labelFor(key),
    hint: outer.description ?? inner.description ?? null,
    widget,
    required,
    nullable: Boolean(variants),
    options: inner.enum ?? [],
    min: inner.minimum ?? inner.exclusiveMinimum ?? null,
    max: inner.maximum ?? inner.exclusiveMaximum ?? null,
    exclusiveMin: inner.minimum === undefined && inner.exclusiveMinimum !== undefined,
    exclusiveMax: inner.maximum === undefined && inner.exclusiveMaximum !== undefined,
    maxLength: inner.maxLength ?? null,
    pattern: inner.pattern ?? null,
    maxItems: inner.maxItems ?? null,
    initial: outer.default ?? null,
    fields,
    item,
    pick: widget === 'food-picker' ? (key === 'recipe_id' ? 'recipe' : 'food') : null,
  };
}

/** Turn a (sub)schema into a Field; `root` holds the $defs that references point into. */
export function toField(
  schema: JsonSchema,
  root: JsonSchema = schema,
  key = '',
  required = false,
): Field {
  return build(schema, root, key, required, key);
}

/** The root field of a form for a command or payload schema, minus the keys in `omit`. */
export function formFor(schema: JsonSchema, omit: string[] = []): Field {
  const root = toField(schema, schema, '', true);
  return { ...root, fields: root.fields.filter((field) => !omit.includes(field.key)) };
}

/** A fresh value for a field: objects get their required children, arrays start empty. */
export function initialValue(field: Field): unknown {
  if (field.widget === 'object') {
    return Object.fromEntries(
      field.fields
        .filter((child) => child.required || child.initial !== null)
        .map((child) => [child.key, initialValue(child)]),
    );
  }
  if (field.widget === 'array' || field.widget === 'multi-enum') {
    return [];
  }
  return field.initial ?? null;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The value to send: only keys the schema knows, empty optional inputs as null (so they
 * clear) or left out (when null is not allowed), and empty required inputs left out so the
 * backend names them.
 */
export function clean(field: Field, value: unknown): unknown {
  if (field.widget === 'object') {
    if (isEmpty(value)) {
      return field.nullable ? null : undefined;
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const child of field.fields) {
      const cleaned = clean(child, source[child.key]);
      if (cleaned !== undefined) {
        result[child.key] = cleaned;
      }
    }
    return result;
  }
  if (field.widget === 'array' || field.widget === 'multi-enum') {
    const items = Array.isArray(value) ? value : [];
    return field.item ? items.map((item) => clean(field.item!, item) ?? null) : items;
  }
  if (isEmpty(value)) {
    return field.nullable ? null : undefined;
  }
  return value;
}

/** An error field path relative to a form rooted at `prefix` ("events.0.payload"). */
export function fieldUnder(path: string | null | undefined, prefix: string): string | null {
  if (!path) {
    return null;
  }
  if (!prefix) {
    return path;
  }
  return path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : null;
}

/** A position inside a form value: property names and array indexes. */
export type Path = (string | number)[];

/** A copy of `root` with the value at `path` replaced by `change(current)`. */
export function updateIn(
  root: unknown,
  path: Path,
  change: (current: unknown) => unknown,
): unknown {
  if (!path.length) {
    return change(root);
  }
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...root] : [];
    list[head] = updateIn(list[head], rest, change);
    return list;
  }
  const record = root && typeof root === 'object' ? { ...(root as Record<string, unknown>) } : {};
  record[head] = updateIn(record[head], rest, change);
  return record;
}
