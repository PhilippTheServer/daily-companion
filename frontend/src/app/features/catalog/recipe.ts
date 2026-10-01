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
import { Router, RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { RecipeOut } from '../../core/api/types';
import { CommandRun } from '../../shared/command-run';
import { CommandForm } from '../../shared/forms/command-form';
import { round } from '../../shared/number';

/** A recipe: items with nutrients, totals per portion, steps and version count; edit or archive. */
@Component({
  selector: 'app-recipe',
  imports: [CommandForm, RouterLink],
  template: `
    @if (isNew()) {
      <h1>New recipe</h1>
      <app-command-form
        command="save_recipe"
        [omit]="['id']"
        [initial]="{ serves: 1 }"
        (done)="created($event)"
        (cancelled)="back()"
      />
    } @else if (recipe.hasValue()) {
      @let current = recipe.value();
      <header class="page-head">
        <h1>{{ current.name }}</h1>
      </header>
      <p class="muted">
        serves {{ current.serves }} · version {{ current.versions }}
        @if (current.archived) {
          · archived
        }
      </p>
      @if (editing()) {
        <app-command-form
          command="save_recipe"
          [fixed]="{ id: current.id }"
          [initial]="editInitial()"
          (done)="editing.set(false)"
          (cancelled)="editing.set(false)"
        />
      } @else {
        <p>
          Per portion: {{ round(current.per_portion.kcal) }} kcal · P
          {{ round(current.per_portion.protein_g) }} g · C
          {{ round(current.per_portion.carbs_g) }} g · F {{ round(current.per_portion.fat_g) }} g
        </p>
        <table class="items">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" class="num">Amount</th>
              <th scope="col" class="num">Energy</th>
            </tr>
          </thead>
          <tbody>
            @for (item of current.items; track item.food_id) {
              <tr>
                <td>
                  <a [routerLink]="['/catalog/food', item.food_id]">{{ item.name }}</a>
                </td>
                <td class="num">{{ item.grams }} g</td>
                <td class="num">{{ round(item.nutrients.kcal) }} kcal</td>
              </tr>
            }
          </tbody>
        </table>
        @if (current.steps.length) {
          <h2>Steps</h2>
          <ol>
            @for (step of current.steps; track $index) {
              <li>{{ step }}</li>
            }
          </ol>
        }
        @if (current.note) {
          <p>{{ current.note }}</p>
        }
        @if (archiving.failure(); as message) {
          <p class="form-error" role="alert">{{ message }}</p>
        }
        @if (!current.archived && archivedId() !== current.id) {
          <div class="actions">
            <button type="button" [disabled]="recipe.isLoading()" (click)="edit()">Edit</button>
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
    } @else if (recipe.error()) {
      <p class="form-error" role="alert">{{ text(recipe.error()) }}</p>
    } @else {
      <p class="muted" role="status">Loading…</p>
    }
  `,
})
export class RecipePage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  readonly id = input.required<string>();

  protected readonly isNew = computed(() => this.id() === 'new');
  protected readonly editing = signal(false);
  protected readonly archivedId = signal<string | null>(null);
  protected readonly archiving = new CommandRun();
  protected readonly text = errorText;
  protected readonly round = round;
  protected readonly recipe = resource({
    params: () => (this.isNew() ? undefined : { id: this.id() }),
    loader: ({ params }) => this.api.view('recipe', { id: params.id }),
  });

  constructor() {
    effect(() => {
      this.id();
      untracked(() => this.archiving.clear());
    });
    reloadAfterCommands(this.recipe);
  }

  protected readonly editInitial = signal<Record<string, unknown>>({});

  protected edit(): void {
    const current = untracked(() => (this.recipe.hasValue() ? this.recipe.value() : null));
    if (!current) {
      return;
    }
    const { name, serves, steps, items, note } = current;
    this.editInitial.set({ name, serves, steps, items, note });
    this.editing.set(true);
  }

  protected async created(result: unknown): Promise<void> {
    await this.router.navigate(['/catalog/recipe', (result as RecipeOut).id], { replaceUrl: true });
  }

  protected async archive(recipe: RecipeOut): Promise<void> {
    const ok = await this.archiving.run(`archive:${recipe.id}`, (idempotency_key) =>
      this.api.command('archive_recipe', { id: recipe.id, idempotency_key }),
    );
    if (ok) {
      this.archivedId.set(recipe.id);
    }
  }

  protected back(): void {
    void this.router.navigate(['/catalog']);
  }
}
