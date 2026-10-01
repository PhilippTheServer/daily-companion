import { Component, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import { DaySummaryView } from '../../shared/timeline/day-summary';
import { KINDS, kindLabel } from '../../shared/timeline/describe';
import { Timeline } from '../../shared/timeline/timeline';
import { reloadOnNewDay } from '../../shared/reload-on-new-day';

/** Today: the four gauges, warnings, the day's timeline and a "+" to log anything. */
@Component({
  selector: 'app-today',
  imports: [RouterLink, DaySummaryView, Timeline],
  template: `
    <header class="page-head">
      <h1>Today</h1>
      <button
        type="button"
        class="add"
        aria-label="Log something"
        aria-controls="kind-picker"
        [attr.aria-expanded]="picking()"
        (click)="picking.set(!picking())"
      >
        +
      </button>
    </header>
    @if (picking()) {
      <nav id="kind-picker" class="kind-picker" aria-label="Log">
        @for (kind of kinds; track kind) {
          <a [routerLink]="['/log', kind]">{{ label(kind) }}</a>
        }
      </nav>
    }
    @if (context.hasValue()) {
      @let view = context.value();
      <app-day-summary [summary]="view.day.summary" />
      @if (view.weight.latest_kg !== null) {
        <p class="muted">
          Weight {{ view.weight.latest_kg }} kg
          @if (view.weight.trend_kg_per_week !== null) {
            · 14-day trend {{ view.weight.trend_kg_per_week > 0 ? '+' : ''
            }}{{ view.weight.trend_kg_per_week }} kg/week
          }
        </p>
      }
      @if (view.warnings.length) {
        <ul class="warnings">
          @for (warning of view.warnings; track warning) {
            <li>{{ warning }}</li>
          }
        </ul>
      }
      <app-timeline [events]="view.day.timeline" />
      @if (view.recent_symptoms.length) {
        <h2>Symptoms, last 3 days</h2>
        <app-timeline [events]="view.recent_symptoms" />
      }
    } @else if (context.error()) {
      <p class="form-error" role="alert">{{ text(context.error()) }}</p>
    } @else {
      <p class="muted" role="status">Loading…</p>
    }
  `,
})
export class TodayPage {
  private readonly api = inject(Api);

  protected readonly kinds = KINDS;
  protected readonly label = kindLabel;
  protected readonly text = errorText;
  protected readonly picking = signal(false);
  protected readonly context = resource({ loader: () => this.api.view('today') });

  constructor() {
    reloadAfterCommands(this.context);
    reloadOnNewDay(this.context);
  }
}
