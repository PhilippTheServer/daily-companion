import {
  Component,
  computed,
  effect,
  inject,
  input,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText, toApiError } from '../../core/api/errors';
import type { EventOut, LinkOut, Relation } from '../../core/api/types';
import { CommandRun } from '../../shared/command-run';
import { EventEditor } from '../../shared/forms/event-editor';
import { humanize } from '../../shared/forms/schema';
import { round } from '../../shared/number';
import { describeEvent, kindLabel } from '../../shared/timeline/describe';
import { addDays, clock, dayLabel } from '../../shared/time';
import { payloadRows, versionLine } from './history';
import { LinkRow } from './link-row';

const RELATIONS: Relation[] = ['suspected_cause', 'part_of', 'follows'];

/** One event: its payload, links and version history, with edit, retract and link. */
@Component({
  selector: 'app-event',
  imports: [EventEditor, LinkRow],
  template: `
    @if (history.hasValue() && head(); as current) {
      @let chain = history.value();
      @if (mode() === 'edit') {
        <app-event-editor
          [kind]="chain.kind"
          [event]="editTarget()"
          (saved)="mode.set('view')"
          (cancelled)="mode.set('view')"
        />
      } @else {
        <header class="page-head">
          <h1>{{ line().title }}</h1>
        </header>
        <p class="muted">
          {{ kind() }} · {{ dayLabel(current.local_day) }} {{ clock(current.occurred_at) }}
          @if (current.ends_at) {
            – {{ clock(current.ends_at) }}
          }
        </p>
        @if (current.retracted) {
          <p class="retracted-note">
            Retracted: this no longer counts.
            @if (current.retract_reason; as why) {
              Reason: {{ why }}
            }
          </p>
        }
        <p>{{ line().detail }}</p>
        @if (items().length) {
          <table class="items">
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Amount</th>
                <th class="num">Energy</th>
              </tr>
            </thead>
            @for (item of items(); track $index) {
              <tr>
                <td>{{ item.name }}</td>
                <td class="num">{{ item.grams }} g</td>
                <td class="num">{{ round(item.nutrients?.kcal) }} kcal</td>
              </tr>
            }
          </table>
        }
        <dl class="rows">
          @for (row of rows(); track row[0]) {
            <dt>{{ row[0] }}</dt>
            <dd>{{ row[1] }}</dd>
          }
        </dl>

        <h2>Links</h2>
        @for (link of chain.links; track link.chain_id + link.relation + link.direction) {
          <app-link-row [link]="link" [busy]="busy()" (unlink)="unlink($event)" />
        } @empty {
          <p class="muted">No links.</p>
        }
        @if (mode() === 'view' && failure(); as message) {
          <p class="form-error" role="alert">{{ message }}</p>
        }

        <h2>History</h2>
        <ol class="history">
          @for (version of versionsNewestFirst(); track version.id) {
            <li>v{{ version.version }} · {{ versionText(version) }}</li>
          }
        </ol>

        @if (!current.retracted) {
          @switch (mode()) {
            @case ('retract') {
              <form class="inline" (submit)="$event.preventDefault(); retract()">
                @if (failure(); as message) {
                  <p class="form-error" role="alert">{{ message }}</p>
                }
                <label>
                  <span class="label">Reason (optional)</span>
                  <input
                    name="reason"
                    [value]="reason()"
                    (input)="reason.set($any($event.target).value)"
                  />
                </label>
                <div class="actions">
                  <button type="button" class="secondary" (click)="mode.set('view')">Cancel</button>
                  <button type="submit" class="danger" [disabled]="busy()">Retract</button>
                </div>
              </form>
            }
            @case ('link') {
              <section class="inline">
                <label>
                  <span class="label">Relation</span>
                  <select name="relation" (change)="relation.set($any($event.target).value)">
                    @for (option of relations; track option) {
                      <option [value]="option" [selected]="relation() === option">
                        {{ words(option) }}
                      </option>
                    }
                  </select>
                </label>
                <p class="muted">Link to an entry from this day or the day before:</p>
                @if (failure(); as message) {
                  <p class="form-error" role="alert">{{ message }}</p>
                }
                @if (candidates.error(); as failed) {
                  <p class="form-error" role="alert">{{ text(failed) }}</p>
                }
                @if (candidates.isLoading()) {
                  <p class="muted" role="status">Loading…</p>
                } @else if (candidates.hasValue() && !candidateList().length) {
                  <p class="muted">Nothing to link to on these days.</p>
                }
                <ul class="candidates">
                  @for (candidate of candidateList(); track candidate.id) {
                    <li>
                      <button type="button" [disabled]="busy()" (click)="link(candidate)">
                        {{ stamp(candidate, current.local_day) }} {{ titleOf(candidate) }}
                      </button>
                    </li>
                  }
                </ul>
                <button type="button" class="secondary" (click)="mode.set('view')">Cancel</button>
              </section>
            }
            @default {
              <div class="actions">
                <button type="button" (click)="mode.set('edit')">Edit</button>
                <button type="button" class="secondary" (click)="mode.set('link')">Link</button>
                <button type="button" class="danger" (click)="mode.set('retract')">Retract</button>
              </div>
            }
          }
        }
      }
    } @else if (history.error()) {
      <p class="form-error" role="alert">{{ text(history.error()) }}</p>
    } @else {
      <p class="muted" role="status">Loading…</p>
    }
  `,
})
export class EventPage {
  private readonly api = inject(Api);

  readonly chain = input.required<string>();

  protected readonly mode = signal<'view' | 'edit' | 'retract' | 'link'>('view');
  protected readonly reason = signal('');
  protected readonly relation = signal<Relation>('suspected_cause');
  protected readonly relations = RELATIONS;
  protected readonly words = humanize;
  protected readonly clock = clock;
  protected readonly dayLabel = (day: string) => dayLabel(day);
  protected readonly text = errorText;
  protected readonly round = round;
  protected readonly versionText = (version: EventOut) => versionLine(version);
  protected readonly stamp = (candidate: EventOut, day: string) =>
    candidate.local_day === day
      ? clock(candidate.occurred_at)
      : `${dayLabel(candidate.local_day)} ${clock(candidate.occurred_at)}`;
  protected readonly titleOf = (event: EventOut) => describeEvent(event).title;

  protected readonly history = resource({
    params: () => ({ chain_id: this.chain() }),
    loader: ({ params }) => this.api.view('event', params),
  });
  protected readonly head = computed(
    () => (this.history.hasValue() ? this.history.value().versions.at(-1) : undefined) ?? null,
  );
  protected readonly editTarget = computed(() => this.head(), {
    equal: (a, b) => a?.id === b?.id,
  });
  protected readonly kind = computed(() =>
    this.history.hasValue() ? kindLabel(this.history.value().kind) : '',
  );
  protected readonly line = computed(() => {
    const head = this.head();
    return head ? describeEvent(head) : { title: '', detail: '' };
  });
  protected readonly rows = computed(() => {
    const head = this.head();
    return head ? payloadRows(head.payload as Record<string, unknown>) : [];
  });
  protected readonly items = computed(
    () =>
      ((this.head()?.payload as Record<string, unknown> | undefined)?.['items'] ?? []) as {
        name: string;
        grams: number;
        nutrients?: { kcal?: number };
      }[],
  );
  protected readonly versionsNewestFirst = computed(() =>
    [...(this.history.hasValue() ? this.history.value().versions : [])].reverse(),
  );
  protected readonly candidateList = computed(() =>
    this.candidates.hasValue() ? this.candidates.value() : [],
  );
  protected readonly candidates = resource({
    params: () => (this.mode() === 'link' ? this.head()?.local_day : undefined),
    loader: async ({ params: day }) => {
      const [before, same] = await Promise.all([
        this.api.view('day', { date: addDays(day, -1) }),
        this.api.view('day', { date: day }),
      ]);
      return [...before.timeline, ...same.timeline].filter(
        (event) => event.chain_id !== this.chain(),
      );
    },
  });

  private readonly command = new CommandRun((error) => {
    if (toApiError(error).code === 'stale_head') {
      this.history.reload();
      return 'This entry changed meanwhile; review and try again.';
    }
    return errorText(error);
  });
  protected readonly busy = this.command.busy;
  protected readonly failure = this.command.failure;

  constructor() {
    reloadAfterCommands(this.history);
    effect(() => {
      this.mode();
      untracked(() => {
        this.command.clear();
        this.reason.set('');
        this.relation.set('suspected_cause');
      });
    });
    effect(() => {
      this.chain();
      untracked(() => {
        this.mode.set('view');
        this.command.clear();
        this.reason.set('');
        this.relation.set('suspected_cause');
      });
    });
  }

  protected async retract(): Promise<void> {
    const id = this.head()?.id;
    if (!id) {
      return;
    }
    const reason = this.reason() || null;
    await this.run(`retract:${id}:${reason}`, (idempotency_key) =>
      this.api.command('retract_event', { id, reason, idempotency_key }),
    );
  }

  protected async link(target: EventOut): Promise<void> {
    const body = {
      from_chain: this.chain(),
      to_chain: target.chain_id,
      relation: this.relation(),
    };
    await this.run(`link:${body.from_chain}:${body.to_chain}:${body.relation}`, (idempotency_key) =>
      this.api.command('link_events', { ...body, idempotency_key }),
    );
  }

  protected async unlink(link: LinkOut): Promise<void> {
    const [from_chain, to_chain] =
      link.direction === 'outgoing' ? [this.chain(), link.chain_id] : [link.chain_id, this.chain()];
    await this.run(`unlink:${from_chain}:${to_chain}:${link.relation}`, (idempotency_key) =>
      this.api.command('unlink_events', {
        from_chain,
        to_chain,
        relation: link.relation,
        idempotency_key,
      }),
    );
  }

  private async run(
    signature: string,
    send: (idempotency_key: string) => Promise<{ warnings?: string[] }>,
  ): Promise<void> {
    if (await this.command.run(signature, send)) {
      this.mode.set('view');
    }
  }
}
