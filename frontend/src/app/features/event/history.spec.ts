import { event } from '../../../testing/events';
import { addDays, clock, dayLabel, localDay } from '../../shared/time';
import { payloadRows, versionLine } from './history';

describe('versionLine', () => {
  it('says who logged and who corrected, and when', () => {
    const first = event({ version: 1, source: 'app', recorded_at: '2026-09-29T06:15:00Z' });
    const second = event({ version: 2, source: 'claude', recorded_at: '2026-09-29T12:02:00Z' });
    const day = localDay(new Date(second.recorded_at));
    expect(versionLine(first, localDay(new Date(first.recorded_at)))).toBe(
      `logged by app at ${clock(first.recorded_at)}`,
    );
    expect(versionLine(second, day)).toBe(`corrected by claude at ${clock(second.recorded_at)}`);
    expect(versionLine(second, addDays(day, 7))).toBe(
      `corrected by claude at ${clock(second.recorded_at)}, ${dayLabel(day, addDays(day, 7))}`,
    );
  });
});

describe('payloadRows', () => {
  it('lists the set values and sums up nested ones', () => {
    expect(
      payloadRows({
        bristol: 4,
        urgency: null,
        flags: ['mucus', 'blood'],
        note: '',
        stages: { deep_min: 90 },
      }),
    ).toEqual([
      ['bristol', '4'],
      ['flags', 'mucus, blood'],
      ['stages', 'deep min 90'],
    ]);
  });
});
