/** A nutrient amount rounded to a whole number; missing counts as 0. */
export function round(value: unknown): number {
  return Math.round(Number(value ?? 0));
}
