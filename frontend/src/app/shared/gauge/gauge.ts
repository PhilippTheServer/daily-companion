import { Component, computed, input } from '@angular/core';
import type { Gauge } from '../../core/api/types';

const LABELS: Record<Gauge['name'], string> = {
  kcal: 'Energy',
  protein: 'Protein',
  carbs: 'Carbs',
  fat: 'Fat',
};
const NEAR = 0.1;

/** One day gauge: value against target as a meter, with the remainder spelled out. */
@Component({
  selector: 'app-gauge',
  template: `
    <div class="gauge" [attr.data-state]="state()">
      <span class="name">{{ label() }}</span>
      <span class="value"
        >{{ value() }} <small>{{ unit() }}</small></span
      >
      <div
        class="meter"
        role="meter"
        [attr.aria-label]="label()"
        [attr.aria-valuenow]="meterValue()"
        [attr.aria-valuemin]="hasTarget() ? 0 : null"
        [attr.aria-valuemax]="meterMax()"
        [attr.aria-valuetext]="rest()"
      >
        <div class="fill" [style.width.%]="fill()"></div>
      </div>
      <span class="rest">{{ rest() }}</span>
    </div>
  `,
  styles: `
    .gauge {
      display: grid;
      gap: 0.25rem;
      padding: 0.75rem;
      border-radius: 0.75rem;
      background: var(--surface);
      border: 1px solid var(--line);
    }
    .name {
      color: var(--ink-2);
      font-size: 0.85rem;
    }
    .value {
      font-size: 1.5rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .value small {
      font-size: 0.8rem;
      font-weight: 400;
      color: var(--ink-2);
    }
    .meter {
      height: 0.5rem;
      border-radius: 0.25rem;
      background: var(--track);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      border-radius: 0.25rem;
      background: var(--accent);
    }
    [data-state='over'] .fill {
      background: var(--warning);
    }
    .rest {
      color: var(--ink-2);
      font-size: 0.8rem;
    }
  `,
})
export class GaugeView {
  readonly gauge = input.required<Gauge>();

  protected readonly label = computed(() => LABELS[this.gauge().name]);
  protected readonly unit = computed(() => (this.gauge().name === 'kcal' ? 'kcal' : 'g'));
  protected readonly value = computed(() => Math.round(this.gauge().value));
  protected readonly hasTarget = computed(() => {
    const { target } = this.gauge();
    return target != null && target !== 0;
  });
  protected readonly meterMax = computed(() => (this.hasTarget() ? this.gauge().target : null));
  protected readonly meterValue = computed(() =>
    this.hasTarget() ? Math.min(Math.max(this.gauge().value, 0), this.gauge().target!) : null,
  );
  protected readonly fill = computed(() => Math.min(1, this.gauge().ratio ?? 0) * 100);
  protected readonly state = computed(() => {
    const ratio = this.gauge().ratio;
    if (!this.hasTarget() || ratio == null) {
      return 'none';
    }
    return ratio > 1 + NEAR ? 'over' : ratio >= 1 - NEAR ? 'near' : 'under';
  });
  protected readonly rest = computed(() => {
    const { value, target } = this.gauge();
    if (!this.hasTarget()) {
      return 'no target';
    }
    const difference = Math.round(target! - value);
    return difference >= 0
      ? `${difference} ${this.unit()} left of ${Math.round(target!)}`
      : `${-difference} ${this.unit()} over ${Math.round(target!)}`;
  });
}
