import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { Api } from '../../core/api/api';
import { ApiError, errorText, toApiError } from '../../core/api/errors';
import type { CommandInput, EventOut, Kind } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { kindLabel } from '../timeline/describe';
import { fromLocalInput, nowIso, toLocalInput } from '../time';
import { Field, JsonSchema, clean, fieldUnder, formFor } from './schema';
import { SchemaForm } from './schema-form';

let nextId = 0;

type Draft = CommandInput<'log_events'>['events'][number];

/** Whether a kind has an end time; mirrors the journal's time rule per kind. */
export const ENDS: Record<Kind, 'forbidden' | 'optional' | 'required'> = {
  intake: 'forbidden',
  outtake: 'forbidden',
  symptom: 'optional',
  medication: 'forbidden',
  supplement: 'forbidden',
  sleep: 'required',
  activity: 'required',
  workout: 'optional',
  measurement: 'forbidden',
  checkin: 'forbidden',
  note: 'forbidden',
};

/** A stored payload as its input form: an intake from a recipe is edited as the recipe. */
export function editablePayload(event: EventOut): Record<string, unknown> {
  const payload = { ...(event.payload as Record<string, unknown>) };
  if (event.kind === 'intake' && payload['recipe_id']) {
    payload['items'] = [];
  }
  return payload;
}

/** Create (log_events) or correct (correct_event) one event with a generated payload form. */
@Component({
  selector: 'app-event-editor',
  imports: [SchemaForm],
  template: `
    @if (form(); as field) {
      <form (submit)="$event.preventDefault(); save()">
        <h2>{{ event() ? 'Edit' : 'Log' }} {{ title() }}</h2>
        <label [class.invalid]="timeError() === 'occurred_at'">
          <span class="label"
            >{{ ends() === 'forbidden' ? 'Time' : 'Start' }}<b aria-hidden="true"> *</b></span
          >
          <input
            type="datetime-local"
            name="occurred_at"
            required
            [attr.aria-invalid]="timeError() === 'occurred_at' || null"
            [attr.aria-describedby]="timeError() === 'occurred_at' ? errorId : null"
            [value]="local(occurredAt())"
            (change)="occurredAt.set(iso($any($event.target).value) ?? occurredAt())"
          />
        </label>
        @if (ends() !== 'forbidden') {
          <label [class.invalid]="timeError() === 'ends_at'">
            <span class="label"
              >End
              @if (ends() === 'required') {
                <b aria-hidden="true"> *</b>
              }
            </span>
            <input
              type="datetime-local"
              name="ends_at"
              [attr.aria-invalid]="timeError() === 'ends_at' || null"
              [attr.aria-describedby]="timeError() === 'ends_at' ? errorId : null"
              [required]="ends() === 'required'"
              [value]="endsAt() ? local(endsAt()!) : ''"
              (change)="
                endsAt.set(
                  $any($event.target).value ? (iso($any($event.target).value) ?? endsAt()) : null
                )
              "
            />
          </label>
        }
        <app-schema-form
          [field]="field"
          [(value)]="payload"
          [errorPath]="payloadError()"
          [errorMessage]="error()?.message ?? ''"
        />
        @if (error(); as failure) {
          <p class="form-error" role="alert" [id]="errorId">{{ text(failure) }}</p>
        }
        <div class="actions">
          <button type="button" class="secondary" (click)="cancelled.emit()">Cancel</button>
          <button type="submit" [disabled]="busy()">Save</button>
        </div>
      </form>
    } @else if (unavailable(); as reason) {
      <p class="form-error" role="alert">{{ reason }}</p>
      <div class="actions">
        <button type="button" class="secondary" (click)="cancelled.emit()">Cancel</button>
      </div>
    }
  `,
})
export class EventEditor {
  private readonly api = inject(Api);
  private readonly notices = inject(Notices);

  readonly kind = input.required<Kind>();
  readonly event = input<EventOut | null>(null);
  readonly saved = output<EventOut>();
  readonly cancelled = output<void>();

  protected readonly schemas = resource({ loader: () => this.api.schemas() });
  private readonly built = computed<{ field: Field } | { reason: string } | null>(() => {
    if (this.schemas.error()) {
      return { reason: errorText(this.schemas.error()) };
    }
    const payloads = this.schemas.hasValue() ? this.schemas.value().payloads : undefined;
    if (!payloads) {
      return null;
    }
    const schema = payloads[this.kind()] as JsonSchema | undefined;
    if (!schema) {
      return { reason: `There is no form for “${this.kind()}”.` };
    }
    try {
      return { field: formFor(schema) };
    } catch {
      return { reason: `The form for “${this.kind()}” cannot be shown.` };
    }
  });
  protected readonly form = computed(() => {
    const built = this.built();
    return built && 'field' in built ? built.field : null;
  });
  protected readonly unavailable = computed(() => {
    const built = this.built();
    return built && 'reason' in built ? built.reason : null;
  });
  protected readonly title = computed(() => kindLabel(this.kind()).toLowerCase());
  protected readonly ends = computed(() => ENDS[this.kind()]);
  protected readonly payload = signal<Record<string, unknown>>({});
  protected readonly occurredAt = signal(nowIso());
  protected readonly endsAt = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly prefix = computed(() => (this.event() ? '' : 'events.0.'));
  protected readonly payloadError = computed(() =>
    fieldUnder(this.error()?.field, `${this.prefix()}payload`),
  );
  protected readonly timeError = computed(() =>
    fieldUnder(this.error()?.field, this.prefix().slice(0, -1)),
  );
  protected readonly local = toLocalInput;
  protected readonly iso = fromLocalInput;
  protected readonly text = errorText;
  protected readonly errorId = `event-editor-error-${nextId++}`;
  private attempt = { signature: '', key: crypto.randomUUID() };

  constructor() {
    effect(() => {
      const event = this.event();
      this.kind();
      untracked(() => {
        this.payload.set(event ? editablePayload(event) : {});
        this.occurredAt.set(event ? event.occurred_at : nowIso());
        this.endsAt.set(event ? event.ends_at : null);
        this.error.set(null);
        this.attempt = { signature: '', key: crypto.randomUUID() };
      });
    });
  }

  protected async save(): Promise<void> {
    const field = this.form();
    if (!field || this.busy()) {
      return;
    }
    const payload = clean(field, this.payload()) as Record<string, unknown>;
    const endsAt = this.ends() === 'forbidden' ? null : this.endsAt();
    const current = this.event();
    const signature = JSON.stringify([
      current?.id ?? this.kind(),
      this.occurredAt(),
      endsAt,
      payload,
    ]);
    if (this.attempt.signature !== signature) {
      this.attempt = { signature, key: crypto.randomUUID() };
    }
    const idempotency_key = this.attempt.key;
    this.busy.set(true);
    this.error.set(null);
    let saved: EventOut;
    let warnings: string[] | undefined;
    try {
      const response = current
        ? await this.api.command('correct_event', {
            id: current.id,
            occurred_at: this.occurredAt(),
            ends_at: endsAt,
            payload,
            idempotency_key,
          })
        : await this.api.command('log_events', {
            events: [
              {
                kind: this.kind(),
                occurred_at: this.occurredAt(),
                ...(endsAt ? { ends_at: endsAt } : {}),
                payload,
              } as Draft,
            ],
            idempotency_key,
          });
      saved = 'events' in response.result ? response.result.events[0] : response.result;
      warnings = response.warnings;
    } catch (error) {
      this.error.set(toApiError(error));
      return;
    } finally {
      this.busy.set(false);
    }
    this.attempt = { signature: '', key: crypto.randomUUID() };
    this.notices.warnings(warnings);
    this.saved.emit(saved);
  }
}
