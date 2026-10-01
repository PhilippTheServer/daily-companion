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
import { Router } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { FoodOut } from '../../core/api/types';
import { CommandRun } from '../../shared/command-run';
import { CommandForm } from '../../shared/forms/command-form';
import { labelFor } from '../../shared/forms/schema';

/** A food: facts per 100 g, its version count and source; edit (new nutrients = new version) or archive. */
@Component({
  selector: 'app-food',
  imports: [CommandForm],
  template: `
    @if (isNew()) {
      <h1>New food</h1>
      <app-command-form
        command="save_food"
        [omit]="['id']"
        [initial]="{ kind: 'food' }"
        (done)="created($event)"
        (cancelled)="back()"
      />
    } @else if (food.hasValue()) {
      @let current = food.value();
      <header class="page-head">
        <h1>{{ current.name }}</h1>
      </header>
      <p class="muted">
        {{ current.brand ?? 'no brand' }} · {{ current.kind }} ·
        {{ current.source === 'off' ? 'Open Food Facts' : 'manual' }} · version
        {{ current.versions }}
        @if (current.archived) {
          · archived
        }
      </p>
      @if (editing()) {
        <app-command-form
          command="save_food"
          [fixed]="{ id: current.id }"
          [initial]="editInitial()"
          (done)="editing.set(false)"
          (cancelled)="editing.set(false)"
        />
      } @else {
        <h2>Per 100 {{ current.kind === 'drink' ? 'ml' : 'g' }}</h2>
        <dl class="rows">
          @for (row of per100(); track row[0]) {
            <dt>{{ row[0] }}</dt>
            <dd>{{ row[1] }}</dd>
          }
          @if (current.unit_name) {
            <dt>Unit</dt>
            <dd>1 {{ current.unit_name }} = {{ current.unit_grams }} g</dd>
          }
          @if (current.pack_grams) {
            <dt>Pack</dt>
            <dd>{{ current.pack_grams }} g</dd>
          }
          @if (current.barcode) {
            <dt>Barcode</dt>
            <dd>{{ current.barcode }}</dd>
          }
        </dl>
        @if (archiving.failure(); as message) {
          <p class="form-error" role="alert">{{ message }}</p>
        }
        @if (!current.archived && archivedId() !== current.id) {
          <div class="actions">
            <button type="button" [disabled]="food.isLoading()" (click)="edit()">Edit</button>
            <button
              type="button"
              class="danger"
              [disabled]="archiving.busy()"
              (click)="archive(current)"
            >
              Archive
            </button>
          </div>
        }
      }
    } @else if (food.error()) {
      <p class="form-error" role="alert">{{ text(food.error()) }}</p>
    } @else {
      <p class="muted" role="status">Loading…</p>
    }
  `,
})
export class FoodPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  readonly id = input.required<string>();

  protected readonly isNew = computed(() => this.id() === 'new');
  protected readonly editing = signal(false);
  protected readonly archivedId = signal<string | null>(null);
  protected readonly archiving = new CommandRun();
  protected readonly text = errorText;
  protected readonly food = resource({
    params: () => (this.isNew() ? undefined : { id: this.id() }),
    loader: ({ params }) => this.api.view('food', { id: params.id }),
  });
  protected readonly per100 = computed(() =>
    Object.entries(this.food.hasValue() ? this.food.value().per_100 : {})
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [labelFor(key), String(value)]),
  );

  constructor() {
    effect(() => {
      this.id();
      untracked(() => this.archiving.clear());
    });
    reloadAfterCommands(this.food);
  }

  protected readonly editInitial = signal<Record<string, unknown>>({});

  protected edit(): void {
    const current = untracked(() => (this.food.hasValue() ? this.food.value() : null));
    if (!current) {
      return;
    }
    const { name, brand, kind, unit_name, unit_grams, pack_grams, per_100 } = current;
    this.editInitial.set({ name, brand, kind, unit_name, unit_grams, pack_grams, per_100 });
    this.editing.set(true);
  }

  protected async created(result: unknown): Promise<void> {
    await this.router.navigate(['/catalog/food', (result as FoodOut).id], { replaceUrl: true });
  }

  protected async archive(food: FoodOut): Promise<void> {
    const ok = await this.archiving.run(`archive:${food.id}`, (idempotency_key) =>
      this.api.command('archive_food', { id: food.id, idempotency_key }),
    );
    if (ok) {
      this.archivedId.set(food.id);
    }
  }

  protected back(): void {
    void this.router.navigate(['/catalog']);
  }
}
