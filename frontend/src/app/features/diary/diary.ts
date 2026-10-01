import { Component, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { DiaryDay, Kind } from '../../core/api/types';
import { KINDS, kindLabel } from '../../shared/timeline/describe';
import { Timeline } from '../../shared/timeline/timeline';
import { Visible } from '../../shared/timeline/visible';
import { dayLabel } from '../../shared/time';

const PAGE_DAYS = 7;

/** The continuous diary: newest day first, every entry a time-stamped row, older days on scroll. */
@Component({
  selector: 'app-diary',
  imports: [RouterLink, Timeline, Visible],
  template: `
    <header class="page-head"><h1>Diary</h1></header>
    <nav class="chips" aria-label="Filter by kind">
      @for (kind of kinds; track kind) {
        <button
          type="button"
          [class.on]="filter().includes(kind)"
          [attr.aria-pressed]="filter().includes(kind)"
          (click)="toggle(kind)"
        >
          {{ label(kind) }}
        </button>
      }
    </nav>
    @for (day of days(); track day.day) {
      <section class="diary-day">
        <h2 class="day-head">
          <a [routerLink]="['/day', day.day]">{{ dayTitle(day.day) }}</a>
        </h2>
        <app-timeline [events]="day.events" />
      </section>
    }
    @if (error()) {
      <p class="form-error" role="alert">{{ error() }}</p>
    }
    @if (done()) {
      <p class="muted end">{{ days().length ? 'No older entries.' : 'Nothing logged yet.' }}</p>
    } @else {
      <button
        type="button"
        class="secondary more"
        [disabled]="loading()"
        (appVisible)="auto()"
        (click)="more()"
      >
        {{ loading() ? 'Loading…' : 'Load older days' }}
      </button>
    }
  `,
  styles: `
    .day-head {
      position: sticky;
      top: 0;
      margin: 0;
      padding: 0.75rem 0 0.25rem;
      background: var(--page);
      font-size: 0.95rem;
    }
    .day-head a {
      color: var(--ink);
      text-decoration: none;
    }
    .more,
    .end {
      display: block;
      margin: 1.5rem auto;
    }
  `,
})
export class DiaryPage {
  private readonly api = inject(Api);
  private generation = 0;
  private readonly sentinel = viewChild(Visible);

  protected readonly kinds = KINDS;
  protected readonly label = kindLabel;
  protected readonly dayTitle = (day: string) => dayLabel(day);
  protected readonly filter = signal<Kind[]>([]);
  protected readonly days = signal<DiaryDay[]>([]);
  protected readonly cursor = signal<string | null>(null);
  protected readonly done = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.api.revision();
      this.filter();
      untracked(() => this.restart());
    });
  }

  protected toggle(kind: Kind): void {
    this.filter.update((kinds) =>
      kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind],
    );
  }

  protected auto(): void {
    if (!this.error()) {
      void this.more();
    }
  }

  protected async more(): Promise<void> {
    if (this.loading() || this.done()) {
      return;
    }
    const generation = this.generation;
    this.loading.set(true);
    this.error.set(null);
    try {
      const kinds = this.filter();
      const page = await this.api.view('diary', {
        cursor: this.cursor(),
        days: PAGE_DAYS,
        kinds: kinds.length ? kinds : null,
      });
      if (generation !== this.generation) {
        return;
      }
      this.days.update((days) => [...days, ...page.days]);
      this.cursor.set(page.next_cursor);
      this.done.set(page.next_cursor === null);
      this.rearm();
    } catch (error) {
      if (generation === this.generation) {
        this.error.set(errorText(error));
      }
    } finally {
      if (generation === this.generation) {
        this.loading.set(false);
      }
    }
  }

  private rearm(): void {
    this.sentinel()?.rearm();
  }

  private restart(): void {
    this.generation++;
    this.days.set([]);
    this.cursor.set(null);
    this.done.set(false);
    this.loading.set(false);
    this.error.set(null);
    void this.more();
  }
}
