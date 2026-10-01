import { addDays, dayLabel, duration, fromLocalInput, localDay, toLocalInput } from './time';

declare const process: { env: Record<string, string | undefined> };

/** Runs `body` with the process time zone set to `zone`; Node re-reads TZ on every assignment. */
function inZone(zone: string, body: () => void): () => void {
  return () => {
    const previous = process.env['TZ'];
    process.env['TZ'] = zone;
    try {
      body();
    } finally {
      if (previous === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = previous;
      }
    }
  };
}

describe('time', () => {
  it('writes a local input as ISO with an offset for the same instant', () => {
    const iso = fromLocalInput('2026-09-29T08:15')!;
    expect(iso).toMatch(/^2026-09-29T08:15:00[+-]\d\d:\d\d$/);
    expect(new Date(iso).getTime()).toBe(new Date('2026-09-29T08:15').getTime());
    expect(toLocalInput(iso)).toBe('2026-09-29T08:15');
  });

  it('keeps given seconds and rejects empty or invalid input', () => {
    expect(fromLocalInput('2026-09-29T08:15:42')).toMatch(/^2026-09-29T08:15:42[+-]\d\d:\d\d$/);
    for (const bad of [
      '',
      null,
      undefined,
      'x',
      '2026-09-29',
      '2026-09-29T08',
      '2026-02-30T08:15',
    ]) {
      expect(fromLocalInput(bad)).toBeNull();
    }
    expect(fromLocalInput('2026-09-29T24:00')).toBeNull();
    expect(fromLocalInput('2026-09-29T08:60')).toBeNull();
    expect(fromLocalInput('2026-09-29T08:15:60')).toBeNull();
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('labels today, yesterday and older days', () => {
    expect(dayLabel('2026-09-29', '2026-09-29')).toBe('Today');
    expect(dayLabel('2026-09-28', '2026-09-29')).toBe('Yesterday');
    expect(dayLabel('2026-09-21', '2026-09-29')).toBe('Mon 21 Sep');
  });

  it('formats durations', () => {
    expect(duration('2026-09-28T22:40:00Z', '2026-09-29T06:00:00Z')).toBe('7 h 20 min');
    expect(duration('2026-09-29T10:00:00Z', '2026-09-29T10:45:00Z')).toBe('45 min');
  });

  it('prefixes a negative duration with a minus sign and its absolute value', () => {
    expect(duration('2026-09-29T06:00:00Z', '2026-09-28T22:40:00Z')).toBe('\u22127 h 20 min');
    expect(duration('2026-09-29T10:45:00Z', '2026-09-29T10:00:00Z')).toBe('\u221245 min');
    expect(duration('2026-09-29T10:00:00Z', '2026-09-29T10:00:00Z')).toBe('0 min');
  });

  it('formats a local day', () => {
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('time in Europe/Berlin', () => {
  it(
    'uses +02:00 in summer and +01:00 in winter',
    inZone('Europe/Berlin', () => {
      expect(fromLocalInput('2026-07-01T09:00')).toBe('2026-07-01T09:00:00+02:00');
      expect(fromLocalInput('2026-01-15T09:00:30')).toBe('2026-01-15T09:00:30+01:00');
      expect(toLocalInput('2026-07-01T07:00:00Z')).toBe('2026-07-01T09:00');
    }),
  );

  it(
    'resolves the DST gap to the offset after the change',
    inZone('Europe/Berlin', () => {
      expect(fromLocalInput('2026-03-29T01:59')).toBe('2026-03-29T01:59:00+01:00');
      expect(fromLocalInput('2026-03-29T02:30')).toBe('2026-03-29T02:30:00+02:00');
      expect(fromLocalInput('2026-03-29T03:00')).toBe('2026-03-29T03:00:00+02:00');
    }),
  );

  it(
    'resolves the DST overlap to the first occurrence',
    inZone('Europe/Berlin', () => {
      expect(fromLocalInput('2026-10-25T02:30')).toBe('2026-10-25T02:30:00+02:00');
      expect(fromLocalInput('2026-10-25T03:00')).toBe('2026-10-25T03:00:00+01:00');
    }),
  );

  it(
    'adds days across DST changes without drifting',
    inZone('Europe/Berlin', () => {
      expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
      expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
      expect(addDays('2026-03-30', -1)).toBe('2026-03-29');
      expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
      expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
      expect(addDays('2026-10-26', -2)).toBe('2026-10-24');
    }),
  );

  it(
    'takes localDay at 23:59 and 00:00 from the local calendar',
    inZone('Europe/Berlin', () => {
      expect(localDay(new Date(2026, 8, 29, 23, 59))).toBe('2026-09-29');
      expect(localDay(new Date(2026, 8, 30, 0, 0))).toBe('2026-09-30');
      expect(localDay(new Date('2026-09-29T22:00:00Z'))).toBe('2026-09-30');
      expect(localDay(new Date('2026-09-29T21:59:00Z'))).toBe('2026-09-29');
    }),
  );
});

describe('time in Asia/Kolkata', () => {
  it(
    'uses +05:30',
    inZone('Asia/Kolkata', () => {
      expect(fromLocalInput('2026-09-29T08:15')).toBe('2026-09-29T08:15:00+05:30');
      expect(toLocalInput('2026-09-29T02:45:00Z')).toBe('2026-09-29T08:15');
      expect(localDay(new Date('2026-09-29T18:30:00Z'))).toBe('2026-09-30');
    }),
  );
});

describe('time in America/Los_Angeles', () => {
  it(
    'uses negative offsets',
    inZone('America/Los_Angeles', () => {
      expect(fromLocalInput('2026-07-01T09:00')).toBe('2026-07-01T09:00:00-07:00');
      expect(fromLocalInput('2026-01-15T09:00')).toBe('2026-01-15T09:00:00-08:00');
      expect(toLocalInput('2026-07-01T16:00:00Z')).toBe('2026-07-01T09:00');
      expect(localDay(new Date('2026-07-01T06:59:00Z'))).toBe('2026-06-30');
    }),
  );
});

describe('addDays across the Europe/Berlin DST switches', () => {
  const cases = [
    ['2026-03-29', '2026-03-28', '2026-03-30'],
    ['2026-10-25', '2026-10-24', '2026-10-26'],
  ] as const;
  for (const [day, before, after] of cases) {
    it(
      `steps one day either way from ${day}`,
      inZone('Europe/Berlin', () => {
        expect(addDays(day, -1)).toBe(before);
        expect(addDays(day, 1)).toBe(after);
      }),
    );
  }

  for (const [day, before, after] of cases) {
    for (const time of ['00:30', '23:30']) {
      it(
        `steps from the local day of ${day} ${time}`,
        inZone('Europe/Berlin', () => {
          const local = localDay(new Date(`${day}T${time}:00`));
          expect(local).toBe(day);
          expect(addDays(local, -1)).toBe(before);
          expect(addDays(local, 1)).toBe(after);
        }),
      );
    }
  }
});
