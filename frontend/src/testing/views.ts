import type { ContextOut, DaySummary, DayView, EventOut } from '../app/core/api/types';

const zero = {
  kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
  sugar_g: 0,
  salt_g: 0,
  fluid_ml: 0,
};

/** A day summary as the backend computes it for 81.4 kg, 182 cm, male, 5250 steps and 45 min of strength. */
export function summary(day = '2026-09-29'): DaySummary {
  return {
    day,
    nutrients: zero,
    fluid_ml: 0,
    sleep: null,
    steps: null,
    weight_kg: 81.4,
    workouts: { count: 0, minutes: 0 },
    symptoms: [],
    outtake_count: 0,
    energy: {
      bmr: 1821.5,
      baseline: 2185.8,
      steps_kcal: 170.9,
      workouts_kcal: 244.2,
      maintenance: 2600.9,
    },
    targets: {
      kcal: 2319,
      protein_g: 146.5,
      carbs_g: 286.8,
      fat_g: 65.1,
      adjustment_kcal: -282,
      missing: [],
      warnings: [],
    },
    gauges: [
      { name: 'kcal', value: 900, target: 2319, ratio: 0.388 },
      { name: 'protein', value: 60, target: 146.5, ratio: 0.41 },
      { name: 'carbs', value: 100, target: 286.8, ratio: 0.349 },
      { name: 'fat', value: 30, target: 65.1, ratio: 0.461 },
    ],
  };
}

/** A day view with the given timeline. */
export function dayView(timeline: EventOut[] = [], day = '2026-09-29'): DayView {
  return { summary: summary(day), timeline };
}

/** A today context with a weight, one warning and the given timeline. */
export function context(timeline: EventOut[] = []): ContextOut {
  return {
    today: '2026-09-29',
    day: dayView(timeline),
    weight: { latest_kg: 81.4, latest_day: '2026-09-29', trend_kg_per_week: -0.3 },
    recent_symptoms: [],
    integrations: [],
    warnings: ['no weight for 7 days'],
  };
}
