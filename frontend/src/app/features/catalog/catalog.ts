import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { FoodOut, RemoteFood } from '../../core/api/types';
import { CommandRun } from '../../shared/command-run';
import { round } from '../../shared/number';

const SEARCH_DELAY_MS = 250;

/** Catalog search: local foods, Open Food Facts hits to import, and recipes. */
@Component({
  selector: 'app-catalog',
  imports: [RouterLink],
  template: `
    <header class="page-head">
      <h1>Catalog</h1>
    </header>
    <input
      type="search"
      name="q"
      aria-label="Search foods and recipes"
      placeholder="Search foods and recipes"
      [value]="typed()"
      (input)="type($any($event.target).value)"
    />
    <div class="actions">
      <a class="button secondary" routerLink="/catalog/food/new">New food</a>
      <a class="button secondary" routerLink="/catalog/recipe/new">New recipe</a>
    </div>
    @if (foods.hasValue()) {
      @let found = foods.value();
      <h2>Foods</h2>
      <ul class="list">
        @for (food of found.local; track food.id) {
          <li>
            <a [routerLink]="['/catalog/food', food.id]">
              {{ food.name }}
              @if (detail(food); as text) {
                <small>{{ text }}</small>
              }
            </a>
          </li>
        } @empty {
          <li class="muted">No saved food matches.</li>
        }
      </ul>
      @if (found.remote.length) {
        <h2>Open Food Facts</h2>
        <ul class="list">
          @for (hit of found.remote; track hit.barcode) {
            <li>
              <span>
                {{ hit.name }}
                @if (hit.brand) {
                  <small>{{ hit.brand }}</small>
                }
              </span>
              <button
                type="button"
                class="link"
                [attr.aria-label]="(hit.usable ? 'Import ' : 'No nutrients for ') + hit.name"
                [disabled]="!hit.usable || importing.busy()"
                (click)="import(hit)"
              >
                {{ hit.usable ? 'Import' : 'No nutrients' }}
              </button>
            </li>
          }
        </ul>
      }
      @if (found.remote_error) {
        <p class="muted">Open Food Facts: {{ found.remote_error }}</p>
      }
    } @else if (foods.error()) {
      <p class="form-error" role="alert">{{ text(foods.error()) }}</p>
    }
    @if (importing.failure(); as message) {
      <p class="form-error" role="alert">{{ message }}</p>
    }
    <h2>Recipes</h2>
    @if (allRecipes.error()) {
      <p class="form-error" role="alert">{{ text(allRecipes.error()) }}</p>
    }
    <ul class="list">
      @for (recipe of recipes(); track recipe.id) {
        <li>
          <a [routerLink]="['/catalog/recipe', recipe.id]">
            {{ recipe.name }} <small>{{ round(recipe.per_portion.kcal) }} kcal/portion</small>
          </a>
        </li>
      } @empty {
        <li class="muted">No recipe matches.</li>
      }
    </ul>
  `,
})
export class CatalogPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly importing = new CommandRun();
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly typed = signal('');
  protected readonly query = signal('');
  protected readonly text = errorText;
  protected readonly round = round;
  protected readonly detail = (food: FoodOut) =>
    [food.brand, food.per_100?.kcal != null ? `${food.per_100.kcal} kcal/100` : null]
      .filter(Boolean)
      .join(' · ');
  protected readonly foods = resource({
    params: () => (this.query().length >= 2 ? { q: this.query() } : undefined),
    loader: ({ params }) => this.api.view('catalog', { q: params.q }),
  });
  protected readonly allRecipes = resource({ loader: () => this.api.view('recipes') });
  protected readonly recipes = computed(() => {
    const needle = this.query().toLowerCase();
    const recipes = this.allRecipes.hasValue() ? this.allRecipes.value().recipes : [];
    return recipes.filter((recipe) => recipe.name.toLowerCase().includes(needle));
  });

  constructor() {
    reloadAfterCommands(this.foods);
    reloadAfterCommands(this.allRecipes);
    effect(() => {
      this.query();
      untracked(() => this.importing.clear());
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected type(text: string): void {
    this.typed.set(text);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.query.set(text.trim()), SEARCH_DELAY_MS);
  }

  protected async import(hit: RemoteFood): Promise<void> {
    let id: string | undefined;
    const ok = await this.importing.run(`import:${hit.barcode}`, async (idempotency_key) => {
      const response = await this.api.command('import_food', {
        barcode: hit.barcode,
        idempotency_key,
      });
      id = response.result.id;
      return response;
    });
    if (ok) {
      await this.router.navigate(['/catalog/food', id]);
    }
  }
}
