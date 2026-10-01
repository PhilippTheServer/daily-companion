import { Component, computed, input } from '@angular/core';
import type { DaySummary } from '../../core/api/types';
import { humanize } from '../forms/schema';
import { GaugeView } from '../gauge/gauge';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The four gauges and the day's other totals, as one block for Today and Day. */
@Component({
  selector: 'app-day-summary',
  imports: [GaugeView],
  template: `
    <section class="gauges" aria-label="Nutrition against targets">
      @for (gauge of summary().gauges; track gauge.name) {
        <app-gauge [gauge]="gauge" />
      }
    </section>
    @if (facts().length) {
      <p class="facts">{{ facts().join(' · ') }}</p>
    }
  `,
  styles: `
    .gauges {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.5rem;
    }
    @media (min-width: 40rem) {
      .gauges {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .facts {
      color: var(--ink-2);
      font-size: 0.875rem;
    }
  `,
})
export class DaySummaryView {
  readonly summary = input.required<DaySummary>();

  protected readonly facts = computed(() => {
    const summary = this.summary();
    const symptoms = summary.symptoms.map((s) => `${humanize(s.type)} ×${s.count}`);
    return [
      summary.fluid_ml ? `${Math.round(summary.fluid_ml)} ml fluid` : '',
      summary.sleep ? `${summary.sleep.hours.toFixed(1)} h sleep` : '',
      summary.steps ? `${summary.steps.steps} steps` : '',
      summary.weight_kg !== null ? `${summary.weight_kg} kg` : '',
      summary.workouts.count
        ? `${plural(summary.workouts.count, 'workout')}, ${Math.round(summary.workouts.minutes)} min`
        : '',
      summary.outtake_count ? plural(summary.outtake_count, 'bowel movement') : '',
      ...symptoms,
    ].filter(Boolean);
  });
}
