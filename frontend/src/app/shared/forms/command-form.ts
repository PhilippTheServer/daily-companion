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
import type { CommandInput, CommandName } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { Field, JsonSchema, clean, formFor } from './schema';
import { SchemaForm } from './schema-form';

/** A form generated from a command's schema; `fixed` values (such as an id) are sent unchanged. */
@Component({
  selector: 'app-command-form',
  imports: [SchemaForm],
  template: `
    @if (form(); as field) {
      <form (submit)="$event.preventDefault(); save()">
        <app-schema-form
          [field]="field"
          [(value)]="value"
          [errorPath]="error()?.field ?? null"
          [errorMessage]="error()?.message ?? ''"
        />
        @if (error(); as failure) {
          <p class="form-error" role="alert">{{ text(failure) }}</p>
        }
        <div class="actions">
          <button type="button" class="secondary" (click)="cancelled.emit()">Cancel</button>
          <button type="submit" [disabled]="busy()">{{ submitLabel() }}</button>
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
export class CommandForm {
  private readonly api = inject(Api);
  private readonly notices = inject(Notices);

  readonly command = input.required<CommandName>();
  readonly initial = input<Record<string, unknown>>({});
  readonly fixed = input<Record<string, unknown>>({});
  readonly omit = input<string[]>([]);
  readonly submitLabel = input('Save');
  readonly done = output<unknown>();
  readonly cancelled = output<void>();

  protected readonly schemas = resource({ loader: () => this.api.schemas() });
  private readonly built = computed<{ field: Field } | { reason: string } | null>(() => {
    if (this.schemas.error()) {
      return { reason: errorText(this.schemas.error()) };
    }
    const commands = this.schemas.hasValue() ? this.schemas.value().commands : undefined;
    if (!commands) {
      return null;
    }
    const schema = commands[this.command()] as JsonSchema | undefined;
    if (!schema) {
      return { reason: `There is no form for “${this.command()}”.` };
    }
    try {
      return { field: formFor(schema, [...this.omit(), ...Object.keys(this.fixed())]) };
    } catch {
      return { reason: `The form for “${this.command()}” cannot be shown.` };
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
  protected readonly value = signal<Record<string, unknown>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly text = errorText;

  private attempt = { signature: '', key: crypto.randomUUID() };

  constructor() {
    effect(() => {
      const initial = this.initial();
      this.command();
      untracked(() => {
        this.value.set({ ...initial });
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
    const payload = { ...(clean(field, this.value()) as object), ...this.fixed() };
    const signature = `${this.command()}:${JSON.stringify(payload)}`;
    if (this.attempt.signature !== signature) {
      this.attempt = { signature, key: crypto.randomUUID() };
    }
    const body = { ...payload, idempotency_key: this.attempt.key };
    this.busy.set(true);
    this.error.set(null);
    let result: unknown;
    let warnings: string[] | undefined;
    try {
      const response = await this.api.command(this.command(), body as CommandInput<CommandName>);
      result = response.result;
      warnings = response.warnings;
    } catch (error) {
      this.error.set(toApiError(error));
      return;
    } finally {
      this.busy.set(false);
    }
    this.attempt = { signature: '', key: crypto.randomUUID() };
    this.notices.warnings(warnings);
    this.done.emit(result);
  }
}
