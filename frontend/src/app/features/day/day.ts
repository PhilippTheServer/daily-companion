import { Component, computed, inject, input, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import { DaySummaryView } from '../../shared/timeline/day-summary';
import { Timeline } from '../../shared/timeline/timeline';
import { addDays, dayLabel, localDay } from '../../shared/time';

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDay(date) === value;
}

/** One date: gauges, totals and timeline, with steps to the day before and after. */
@Component({
  selector: 'app-day',
  imports: [RouterLink, DaySummaryView, Timeline],
  template: `
    @if (valid()) {
      <header class="page-head">
        <a [routerLink]="['/day', previous()]" aria-label="Day before">‹</a>
        <h1>{{ title() }}</h1>
        <a [routerLink]="['/day', next()]" aria-label="Day after">›</a>
      </header>
      @if (day.hasValue()) {
        @let view = day.value();
        <app-day-summary [summary]="view.summary" />
        <app-timeline [events]="view.timeline" />
      } @else if (day.error()) {
        <p class="form-error" role="alert">{{ text(day.error()) }}</p>
      } @else {
        <p class="muted" role="status">Loading…</p>
      }
    } @else {
      <header class="page-head">
        <h1>Not a valid date</h1>
      </header>
      <p><a routerLink="/today">Back to today</a></p>
    }
  `,
})
export class DayPage {
  private readonly api = inject(Api);

  readonly date = input.required<string>();

  protected readonly valid = computed(() => isDay(this.date()));
  protected readonly title = computed(() => dayLabel(this.date()));
  protected readonly previous = computed(() => addDays(this.date(), -1));
  protected readonly next = computed(() => addDays(this.date(), 1));
  protected readonly text = errorText;
  protected readonly day = resource({
    params: () => (this.valid() ? { date: this.date() } : undefined),
    loader: ({ params }) => this.api.view('day', params),
  });

  constructor() {
    reloadAfterCommands(this.day);
  }
}
