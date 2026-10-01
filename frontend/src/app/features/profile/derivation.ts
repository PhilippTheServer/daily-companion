import type { DaySummary, ProfileOut } from '../../core/api/types';

const CAP_WARNING = /capped at/;
const FAT_SHARE_MIN = 0.25;

const n = (value: number | null | undefined) => String(Number((value ?? 0).toFixed(1)));

/**
 * Today's targets explained step by step, following the backend's rules (spec §4.4): maintenance,
 * the goal adjustment, then protein, fat (with its floor) and carbs from what is left. Every
 * number comes from the day summary, shown to the one decimal the backend keeps.
 */
export function derivation(profile: ProfileOut | null, summary: DaySummary): string[] {
  const { energy, targets, weight_kg: weightKg } = summary;
  const lines: string[] = [];
  if (energy.maintenance !== null) {
    lines.push(
      `Maintenance ${n(energy.maintenance)} kcal = BMR ${n(energy.bmr)} × 1.2 (${n(energy.baseline)})` +
        ` + steps ${n(energy.steps_kcal)} + workouts ${n(energy.workouts_kcal)}`,
    );
  }
  if (targets.adjustment_kcal) {
    const sign = targets.adjustment_kcal > 0 ? '+' : '−';
    const capped = (targets.warnings ?? []).some((warning) => CAP_WARNING.test(warning))
      ? ' (capped)'
      : '';
    const goal = profile?.goal_weight_kg
      ? ` toward ${profile.goal_weight_kg} kg by ${profile.goal_date}`
      : '';
    lines.push(
      `Adjustment ${sign}${n(Math.abs(targets.adjustment_kcal))} kcal/day${capped}${goal}`,
    );
  }
  if (targets.kcal != null) {
    lines.push(`Energy target ${n(targets.kcal)} kcal`);
  }
  if (targets.protein_g != null && profile && weightKg !== null) {
    lines.push(
      `Protein ${n(targets.protein_g)} g = ${profile.protein_g_per_kg} g/kg × ${weightKg} kg`,
    );
  }
  if (targets.fat_g != null && targets.kcal != null && profile && weightKg !== null) {
    const floor = profile.fat_g_per_kg_min * weightKg;
    const share = (FAT_SHARE_MIN * targets.kcal) / 9;
    lines.push(
      `Fat ${n(targets.fat_g)} g = the larger of ${profile.fat_g_per_kg_min} g/kg × ${weightKg} kg (${n(floor)} g)` +
        ` and 25 % of ${n(targets.kcal)} kcal ÷ 9 (${n(share)} g):` +
        ` ${floor >= share ? 'the per-kg minimum' : 'the energy share'} wins`,
    );
  }
  if (targets.carbs_g != null && targets.kcal != null) {
    const protein = (targets.protein_g ?? 0) * 4;
    const fat = (targets.fat_g ?? 0) * 9;
    lines.push(
      targets.carbs_g === 0
        ? `Carbs 0 g: protein and fat already use ${n(protein + fat)} kcal of the ${n(targets.kcal)} kcal target`
        : `Carbs ${n(targets.carbs_g)} g = (${n(targets.kcal)} kcal − ${n(protein)} kcal protein − ${n(fat)} kcal fat) ÷ 4`,
    );
  }
  const missing = targets.missing ?? [];
  if (missing.length) {
    lines.push(`Missing for targets: ${missing.join(', ')}`);
  }
  return [...lines, ...(targets.warnings ?? [])];
}
