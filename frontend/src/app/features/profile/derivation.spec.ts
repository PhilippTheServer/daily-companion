import { summary } from '../../../testing/views';
import { derivation } from './derivation';

const profile = {
  id: 'p1',
  valid_from: '2026-09-01T00:00:00Z',
  timezone: 'Europe/Berlin',
  height_cm: 182,
  birth_date: '1999-05-01',
  sex: 'male' as const,
  goal_weight_kg: 78,
  goal_date: '2026-12-31',
  protein_g_per_kg: 1.8,
  fat_g_per_kg_min: 0.8,
  gym_sessions_per_week: 3,
};

const tenths = (line: string) =>
  [...line.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Math.round(+m[0] * 10));

describe('derivation', () => {
  it('explains every target with the backend numbers to one decimal', () => {
    expect(derivation(profile, summary())).toEqual([
      'Maintenance 2600.9 kcal = BMR 1821.5 × 1.2 (2185.8) + steps 170.9 + workouts 244.2',
      'Adjustment −282 kcal/day toward 78 kg by 2026-12-31',
      'Energy target 2319 kcal',
      'Protein 146.5 g = 1.8 g/kg × 81.4 kg',
      'Fat 65.1 g = the larger of 0.8 g/kg × 81.4 kg (65.1 g) and 25 % of 2319 kcal ÷ 9 (64.4 g): the per-kg minimum wins',
      'Carbs 286.8 g = (2319 kcal − 586 kcal protein − 585.9 kcal fat) ÷ 4',
    ]);
  });

  it('shows maintenance parts that add up exactly', () => {
    const [maintenance] = derivation(profile, summary());
    const [total, , , baseline, steps, workouts] = tenths(maintenance);
    expect(baseline + steps + workouts).toBe(total);
  });

  it('says when the energy share wins the fat target', () => {
    const day = summary();
    day.targets = { ...day.targets, kcal: 3000, fat_g: 83.3 };
    expect(derivation(profile, day)).toContain(
      'Fat 83.3 g = the larger of 0.8 g/kg × 81.4 kg (65.1 g) and 25 % of 3000 kcal ÷ 9 (83.3 g): the energy share wins',
    );
  });

  it('shows a positive adjustment with a plus sign', () => {
    const day = summary();
    day.targets = { ...day.targets, adjustment_kcal: 300 };
    expect(derivation(profile, day)[1]).toBe('Adjustment +300 kcal/day toward 78 kg by 2026-12-31');
  });

  it('leaves out an adjustment of zero', () => {
    const day = summary();
    day.targets = { ...day.targets, adjustment_kcal: 0 };
    expect(derivation(profile, day).some((line) => line.startsWith('Adjustment'))).toBe(false);
  });

  it('marks a capped adjustment and appends the backend warning', () => {
    const day = summary();
    const warning = 'goal date not reachable at a safe pace; capped at 750 kcal/day';
    day.targets = { ...day.targets, adjustment_kcal: -750, warnings: [warning] };
    const lines = derivation(profile, day);
    expect(lines[1]).toBe('Adjustment −750 kcal/day (capped) toward 78 kg by 2026-12-31');
    expect(lines.at(-1)).toBe(warning);
  });

  it('does not call an adjustment of exactly 750 capped without the backend warning', () => {
    const day = summary();
    day.targets = { ...day.targets, adjustment_kcal: -750, warnings: [] };
    expect(derivation(profile, day)[1]).toBe('Adjustment −750 kcal/day toward 78 kg by 2026-12-31');
  });

  it('says so when protein and fat leave no energy for carbs', () => {
    const day = summary();
    day.targets = { ...day.targets, kcal: 1000, carbs_g: 0 };
    expect(derivation(profile, day)).toContain(
      'Carbs 0 g: protein and fat already use 1171.9 kcal of the 1000 kcal target',
    );
  });

  it('names what is missing instead of guessing', () => {
    const day = summary();
    day.weight_kg = null;
    day.energy = { bmr: null, baseline: null, steps_kcal: 0, workouts_kcal: 0, maintenance: null };
    day.targets = {
      kcal: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      adjustment_kcal: null,
      missing: ['height_cm', 'weight_kg'],
      warnings: [],
    };
    expect(derivation(null, day)).toEqual(['Missing for targets: height_cm, weight_kg']);
  });

  it('keeps duplicate warnings as separate lines', () => {
    const day = summary();
    day.targets = { ...day.targets, warnings: ['same', 'same'] };
    expect(derivation(profile, day).slice(-2)).toEqual(['same', 'same']);
  });
});
