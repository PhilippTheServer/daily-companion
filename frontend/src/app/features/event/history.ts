import type { EventOut } from '../../core/api/types';
import { clock, dayLabel, localDay } from '../../shared/time';

/** "logged by app at 08:15" for the first version, "corrected by claude at 14:02" after. */
export function versionLine(version: EventOut, today = localDay()): string {
  const verb = version.version === 1 ? 'logged' : 'corrected';
  const day = localDay(new Date(version.recorded_at));
  const when =
    day === today
      ? clock(version.recorded_at)
      : `${clock(version.recorded_at)}, ${dayLabel(day, today)}`;
  return `${verb} by ${version.source} at ${when}`;
}

/** Payload values worth listing, as label/value pairs; lists and nested objects are summed up. */
export function payloadRows(payload: Record<string, unknown>): [string, string][] {
  const hidden = new Set(['items', 'nutrients', 'recipe_version_id', 'exercises']);
  return Object.entries(payload)
    .filter(
      ([key, value]) =>
        !hidden.has(key) &&
        value !== null &&
        value !== '' &&
        !(Array.isArray(value) && !value.length),
    )
    .map(([key, value]) => [
      key.replaceAll('_', ' '),
      Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'object'
          ? Object.entries(value as Record<string, unknown>)
              .map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`)
              .join(', ')
          : String(value),
    ]);
}
