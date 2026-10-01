import { Component, computed, inject, resource, signal, untracked } from '@angular/core';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { ProfileOut, SyncStatusOut } from '../../core/api/types';
import { Auth } from '../../core/auth/auth';
import { Notices } from '../../core/notices';
import { CommandRun } from '../../shared/command-run';
import { CommandForm } from '../../shared/forms/command-form';
import { labelFor } from '../../shared/forms/schema';
import { clock, dayLabel, localDay } from '../../shared/time';
import { derivation } from './derivation';
import { reloadOnNewDay } from '../../shared/reload-on-new-day';

const PROFILE_FIELDS = [
  'timezone',
  'height_cm',
  'birth_date',
  'sex',
  'goal_weight_kg',
  'goal_date',
  'protein_g_per_kg',
  'fat_g_per_kg_min',
  'gym_sessions_per_week',
] as const;

const PROFILE_DEFAULTS = { protein_g_per_kg: 1.8, fat_g_per_kg_min: 0.8 };

/** What the backend fills in when the first profile version is written. */
function firstProfile(): Record<string, unknown> {
  return {
    ...Object.fromEntries(PROFILE_FIELDS.map((key) => [key, null])),
    ...PROFILE_DEFAULTS,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function profileValues(profile: ProfileOut | null): Record<string, unknown> {
  return profile
    ? Object.fromEntries(PROFILE_FIELDS.map((key) => [key, profile[key] ?? null]))
    : firstProfile();
}

/** Body data and goal, targets with their derivation, source preferences and integrations. */
@Component({
  selector: 'app-profile',
  imports: [CommandForm],
  template: `
    <header class="page-head">
      <h1>Profile</h1>
    </header>
    @if (view.hasValue()) {
      @let current = view.value();
      <h2>Body and goal</h2>
      @if (editing() === 'profile') {
        <app-command-form
          command="update_profile"
          [initial]="profileInitial()"
          (done)="editing.set(null)"
          (cancelled)="editing.set(null)"
        />
      } @else {
        <dl class="rows">
          @for (row of profileRows(); track row[0]) {
            <dt>{{ row[0] }}</dt>
            <dd>{{ row[1] }}</dd>
          }
        </dl>
        @if (!editing()) {
          <button
            type="button"
            class="secondary"
            [disabled]="view.isLoading()"
            (click)="editProfile()"
          >
            Edit
          </button>
        }
      }

      <h2>Targets today</h2>
      @if (today.error(); as failed) {
        <p class="form-error" role="alert">{{ text(failed) }}</p>
      }
      @if (today.hasValue()) {
        <ul class="derivation">
          @for (line of explanation(); track $index) {
            <li>{{ line }}</li>
          }
        </ul>
      } @else if (!today.error()) {
        <p class="muted" role="status">Loading targets…</p>
      }

      <h2>Source preferences</h2>
      @if (editing() === 'preference') {
        <app-command-form
          command="set_source_preference"
          [initial]="preference().initial"
          [fixed]="preference().fixed"
          (done)="editing.set(null)"
          (cancelled)="editing.set(null)"
        />
      } @else {
        <ul class="list">
          @for (item of current.source_preferences; track item.metric) {
            <li>
              <span>{{ item.metric }}: {{ item.sources.join(' → ') }}</span>
              @if (!editing()) {
                <button
                  type="button"
                  class="link"
                  [attr.aria-label]="'Edit source preference for ' + item.metric"
                  [disabled]="view.isLoading()"
                  (click)="editPreference(item.metric, item.sources)"
                >
                  Edit
                </button>
              }
            </li>
          } @empty {
            <li class="muted">None set; the newest value wins.</li>
          }
        </ul>
        @if (!editing()) {
          <button
            type="button"
            class="secondary"
            [disabled]="view.isLoading()"
            (click)="editPreference('', [])"
          >
            Add preference
          </button>
        }
      }

      <h2>Integrations</h2>
      @if (syncRun.failure(); as message) {
        <p class="form-error" role="alert">{{ message }}</p>
      }
      <ul class="list">
        @for (status of current.integrations; track status.source) {
          <li class="integration">
            <span>
              <b>{{ status.source }}</b>
              {{ statusText(status) }}
              @if (status.last_error) {
                <span class="form-error">{{ status.last_error }}</span>
              }
            </span>
            <button
              type="button"
              class="link"
              [attr.aria-busy]="syncRun.busy()"
              [disabled]="!status.configured || syncRun.busy()"
              (click)="sync(status)"
            >
              Sync now <span class="visually-hidden">{{ status.source }}</span>
            </button>
          </li>
        } @empty {
          <li class="muted">No integrations configured.</li>
        }
      </ul>
    } @else if (view.error(); as failed) {
      <p class="form-error" role="alert">{{ text(failed) }}</p>
    } @else {
      <p class="muted" role="status">Loading…</p>
    }
    <button type="button" class="secondary signout" (click)="auth.logout()">Sign out</button>
  `,
})
export class ProfilePage {
  private readonly api = inject(Api);
  private readonly notices = inject(Notices);
  protected readonly auth = inject(Auth);
  private syncSource = '';
  protected readonly syncRun = new CommandRun((error) => `${this.syncSource}: ${errorText(error)}`);

  protected readonly editing = signal<'profile' | 'preference' | null>(null);
  protected readonly profileInitial = signal<Record<string, unknown>>({});
  protected readonly preference = signal<{
    initial: Record<string, unknown>;
    fixed: Record<string, unknown>;
  }>({ initial: {}, fixed: {} });
  protected readonly text = errorText;
  protected readonly view = resource({ loader: () => this.api.view('profile') });
  protected readonly today = resource({ loader: () => this.api.view('today') });
  protected readonly profileRows = computed(() => {
    const profile = this.view.hasValue() ? this.view.value().profile : null;
    return PROFILE_FIELDS.map((key) => [key, profile?.[key] ?? null] as const).map(
      ([key, value]) => [labelFor(key), value === null ? '–' : String(value)],
    );
  });
  protected readonly explanation = computed(() => {
    if (!this.view.hasValue() || !this.today.hasValue()) {
      return [];
    }
    return derivation(this.view.value().profile, this.today.value().day.summary);
  });

  constructor() {
    reloadAfterCommands(this.view);
    reloadAfterCommands(this.today);
    reloadOnNewDay(this.today);
  }

  protected editProfile(): void {
    const profile = untracked(() => (this.view.hasValue() ? this.view.value().profile : null));
    this.profileInitial.set(profileValues(profile));
    this.editing.set('profile');
  }

  protected editPreference(metric: string, sources: string[]): void {
    this.preference.set(
      metric
        ? { initial: { sources }, fixed: { metric } }
        : { initial: { metric, sources }, fixed: {} },
    );
    this.editing.set('preference');
  }

  protected statusText(status: SyncStatusOut): string {
    if (!status.configured) {
      return 'not configured';
    }
    if (!status.last_success_at) {
      return 'never synced';
    }
    const day = localDay(new Date(status.last_success_at));
    const counts = Object.entries(status.counts)
      .map(([key, value]) => `${value} ${key}`)
      .join(', ');
    return `synced ${dayLabel(day).toLowerCase()} ${clock(status.last_success_at)}${counts ? ` (${counts})` : ''}`;
  }

  protected async sync(status: SyncStatusOut): Promise<void> {
    const { source } = status;
    this.syncSource = source;
    await this.syncRun.run(`sync:${source}`, async (idempotency_key) => {
      const response = await this.api.command('sync_now', { source, idempotency_key });
      const result = response.result;
      if (!result.last_error) {
        const skipped = result.last_attempt_at === status.last_attempt_at;
        this.notices.show(skipped ? `${source} sync already running` : `${source} synced`);
      }
      return response;
    });
  }
}
