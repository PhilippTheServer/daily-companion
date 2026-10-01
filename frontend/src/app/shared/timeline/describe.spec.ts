import { event } from '../../../testing/events';
import { payloadSchema } from '../../../testing/schemas';
import { KINDS, describeEvent, kindLabel } from './describe';

describe('describeEvent', () => {
  it('sums up an intake with its items and macros', () => {
    const line = describeEvent(
      event({
        kind: 'intake',
        payload: {
          slot: 'breakfast',
          items: [
            { name: 'Oats', grams: 80 },
            { name: 'Skyr', grams: 250 },
          ],
          nutrients: { kcal: 452.6, protein_g: 38.2, carbs_g: 55, fat_g: 7.9 },
        },
      }),
    );
    expect(line).toEqual({
      title: 'Breakfast · Oats, Skyr',
      detail: '453 kcal · P 38 g · C 55 g · F 8 g',
    });
  });

  it('describes each other kind in one line', () => {
    expect(
      describeEvent(event({ kind: 'outtake', payload: { bristol: 4, flags: ['mucus'] } })),
    ).toEqual({
      title: 'Bowel movement',
      detail: 'Bristol 4 · mucus',
    });
    expect(
      describeEvent(event({ kind: 'symptom', payload: { type: 'stomach_ache', severity: 3 } })),
    ).toEqual({ title: 'Stomach ache', detail: 'severity 3/5' });
    expect(
      describeEvent(
        event({
          kind: 'sleep',
          occurred_at: '2026-09-28T22:40:00Z',
          ends_at: '2026-09-29T06:00:00Z',
          payload: { quality: 4 },
        }),
      ),
    ).toEqual({ title: 'Sleep', detail: '7 h 20 min · quality 4/5' });
    expect(
      describeEvent(
        event({ kind: 'measurement', payload: { metric: 'weight_kg', value: 81.4, unit: 'kg' } }),
      ),
    ).toEqual({ title: 'Weight', detail: '81.4 kg' });
    expect(
      describeEvent(
        event({ kind: 'medication', payload: { name: 'Ibuprofen', dose: 400, unit: 'mg' } }),
      ),
    ).toEqual({ title: 'Ibuprofen', detail: '400 mg' });
  });

  it('describes the remaining kinds', () => {
    expect(
      describeEvent(
        event({ kind: 'supplement', payload: { name: 'Vitamin D', dose: 20, unit: 'µg' } }),
      ),
    ).toEqual({ title: 'Vitamin D', detail: '20 µg' });
    expect(
      describeEvent(
        event({ kind: 'activity', payload: { steps: 8123, active_minutes: 41, distance_km: 6.2 } }),
      ),
    ).toEqual({ title: 'Activity', detail: '8123 steps · 41 active min · 6.2 km' });
    expect(
      describeEvent(
        event({
          kind: 'workout',
          occurred_at: '2026-09-29T17:00:00Z',
          ends_at: '2026-09-29T17:45:00Z',
          payload: { title: 'Push day', category: 'strength', set_count: 18 },
        }),
      ),
    ).toEqual({ title: 'Push day', detail: 'Strength · 45 min · 18 sets' });
    expect(
      describeEvent(
        event({ kind: 'checkin', payload: { overall: 4, energy: 3, mood: 5, stress: 2 } }),
      ),
    ).toEqual({ title: 'Check-in', detail: 'overall 4/5 · energy 3/5 · mood 5/5 · stress 2/5' });
    expect(describeEvent(event({ kind: 'note', payload: { text: 'hello' } }))).toEqual({
      title: 'Note',
      detail: 'hello',
    });
  });

  it('leaves out optional fields that are missing', () => {
    expect(describeEvent(event({ kind: 'outtake', payload: { bristol: 3 } }))).toEqual({
      title: 'Bowel movement',
      detail: 'Bristol 3',
    });
    expect(describeEvent(event({ kind: 'sleep', ends_at: null, payload: {} }))).toEqual({
      title: 'Sleep',
      detail: '',
    });
    expect(describeEvent(event({ kind: 'activity', payload: { steps: 100 } })).detail).toBe(
      '100 steps',
    );
    expect(
      describeEvent(event({ kind: 'measurement', payload: { metric: 'weight_kg', value: 80 } })),
    ).toEqual({ title: 'Weight', detail: '80' });
  });

  it('cuts a long note at 120 characters and ends it with an ellipsis', () => {
    const line = describeEvent(event({ kind: 'note', payload: { text: 'x'.repeat(200) } }));
    expect(line.detail).toBe(`${'x'.repeat(120)}…`);
    expect(describeEvent(event({ payload: { text: 'y'.repeat(120) } })).detail).toBe(
      'y'.repeat(120),
    );
  });

  it('titles every measurement metric of the backend schema', () => {
    const metrics = (
      payloadSchema('measurement').properties as unknown as { metric: { enum: string[] } }
    ).metric.enum;
    const titles = Object.fromEntries(
      metrics.map((metric) => [
        metric,
        describeEvent(event({ kind: 'measurement', payload: { metric, value: 1, unit: 'u' } }))
          .title,
      ]),
    );
    expect(titles).toEqual({
      weight_kg: 'Weight',
      waist_cm: 'Waist',
      body_fat_pct: 'Body fat',
      resting_hr_bpm: 'Resting heart rate',
      hrv_ms: 'HRV',
      spo2_pct: 'SpO₂',
      skin_temp_delta_c: 'Skin temperature change',
      blood_pressure_sys: 'Blood pressure (systolic)',
      blood_pressure_dia: 'Blood pressure (diastolic)',
    });
  });

  it('keeps the two blood pressure readings apart', () => {
    const reading = (metric: string) =>
      describeEvent(event({ kind: 'measurement', payload: { metric, value: 120, unit: 'mmHg' } }));
    expect(reading('blood_pressure_sys')).toEqual({
      title: 'Blood pressure (systolic)',
      detail: '120 mmHg',
    });
    expect(reading('blood_pressure_dia').title).toBe('Blood pressure (diastolic)');
  });

  it('lists the 11 kinds in spec order with their labels', () => {
    expect(KINDS).toEqual([
      'intake',
      'outtake',
      'symptom',
      'medication',
      'supplement',
      'sleep',
      'activity',
      'workout',
      'measurement',
      'checkin',
      'note',
    ]);
    expect(KINDS.map(kindLabel)).toEqual([
      'Meal',
      'Bowel movement',
      'Symptom',
      'Medication',
      'Supplement',
      'Sleep',
      'Activity',
      'Workout',
      'Measurement',
      'Check-in',
      'Note',
    ]);
  });
});
