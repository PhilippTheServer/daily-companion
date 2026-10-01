import type { SchemasOut } from '../app/core/api/types';
import type { JsonSchema } from '../app/shared/forms/schema';
import snapshot from './schemas.json';

/** GET /api/v2/schemas as the backend answered when the snapshot was taken. */
export const SCHEMAS = snapshot as unknown as SchemasOut;

export function payloadSchema(kind: string): JsonSchema {
  return SCHEMAS.payloads[kind] as JsonSchema;
}

export function commandSchema(name: string): JsonSchema {
  return SCHEMAS.commands[name] as JsonSchema;
}
