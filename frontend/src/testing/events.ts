import type { EventOut } from '../app/core/api/types';

/** An EventOut with sensible defaults; override what the test is about. */
export function event(overrides: Partial<EventOut> = {}): EventOut {
  return {
    id: 'e-1',
    chain_id: 'c-1',
    version: 1,
    kind: 'note',
    occurred_at: '2026-09-29T08:15:00Z',
    ends_at: null,
    local_day: '2026-09-29',
    payload: { text: 'hello' },
    source: 'app',
    recorded_at: '2026-09-29T08:15:05Z',
    retracted: false,
    retract_reason: null,
    links: [],
    ...overrides,
  };
}
