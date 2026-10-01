import {
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Api } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import { CommandRun } from '../command-run';

interface Choice {
  id: string | null;
  barcode: string | null;
  name: string;
  detail: string;
}

interface Found {
  choices: Choice[];
  warning: string | null;
}

const SEARCH_DELAY_MS = 250;
const MAX_CHOICES = 8;

/** Search the catalog (foods incl. Open Food Facts, or recipes) and emit the chosen id. */
@Component({
  selector: 'app-food-picker',
  template: `
    @if (value() && !searching()) {
      <div class="chosen">
        <span>{{ chosenName() ?? '…' }}</span>
        <button type="button" class="link" (click)="searching.set(true)">Change</button>
      </div>
    } @else {
      <input
        type="search"
        [attr.name]="name()"
        [attr.aria-label]="pick() === 'food' ? 'Search foods' : 'Search recipes'"
        [placeholder]="pick() === 'food' ? 'Search foods' : 'Search recipes'"
        [value]="query()"
        (input)="search($any($event.target).value)"
      />
      @if (error()) {
        <p class="field-error">{{ error() }}</p>
      }
      <ul class="choices">
        @for (choice of choices(); track choice.id ?? choice.barcode) {
          <li>
            <button type="button" (click)="choose(choice)">
              {{ choice.name }} <small>{{ choice.detail }}</small>
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class FoodPicker {
  private readonly api = inject(Api);
  private readonly imports = new CommandRun();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private searchId = 0;
  private nameId = 0;
  private destroyed = false;
  private chosen: { id: string; name: string } | null = null;

  readonly pick = input.required<'food' | 'recipe'>();
  readonly value = input<unknown>(null);
  readonly name = input<string | null>(null);
  readonly picked = output<string>();

  protected readonly chosenName = signal<string | null>(null);
  protected readonly importing = signal(false);
  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly choices = signal<Choice[]>([]);
  protected readonly error = signal<string | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.timer);
    });
    effect(() => {
      const id = this.value();
      untracked(() => this.reset(id));
    });
  }

  protected search(text: string): void {
    this.query.set(text);
    clearTimeout(this.timer);
    const id = ++this.searchId;
    this.timer = setTimeout(() => void this.run(text.trim(), id), SEARCH_DELAY_MS);
  }

  protected async choose(choice: Choice): Promise<void> {
    if (this.importing()) {
      return;
    }
    this.importing.set(true);
    try {
      let id = choice.id;
      if (id === null) {
        const barcode = choice.barcode!;
        const ok = await this.imports.run(`import:${barcode}`, async (idempotency_key) => {
          const response = await this.api.command('import_food', { barcode, idempotency_key });
          id = response.result.id;
          return response;
        });
        if (!ok) {
          if (!this.destroyed) {
            this.error.set(this.imports.failure());
          }
          return;
        }
      }
      if (this.destroyed || id === null) {
        return;
      }
      this.chosen = { id, name: choice.name };
      this.searching.set(false);
      this.choices.set([]);
      this.picked.emit(id);
    } finally {
      this.importing.set(false);
    }
  }

  private reset(id: unknown): void {
    this.nameId++;
    this.searchId++;
    clearTimeout(this.timer);
    const known = this.chosen && this.chosen.id === id ? this.chosen.name : null;
    this.chosenName.set(known);
    this.query.set('');
    this.choices.set([]);
    this.searching.set(false);
    if (known === null && typeof id === 'string' && id) {
      void this.loadName(id, this.nameId);
    }
  }

  private current(id: number): boolean {
    return !this.destroyed && id === this.searchId;
  }

  private async run(text: string, id: number): Promise<void> {
    this.error.set(null);
    if (text.length < 2) {
      this.choices.set([]);
      return;
    }
    try {
      const found = this.pick() === 'food' ? await this.foods(text) : await this.recipes(text);
      if (this.current(id)) {
        this.choices.set(found.choices.slice(0, MAX_CHOICES));
        this.error.set(found.warning);
      }
    } catch (error) {
      if (this.current(id)) {
        this.error.set(errorText(error));
      }
    }
  }

  private async foods(text: string): Promise<Found> {
    const found = await this.api.view('catalog', { q: text });
    const known = new Set(found.local.map((food) => food.barcode).filter(Boolean));
    const choices = [
      ...found.local.map((food) => ({
        id: food.id,
        barcode: food.barcode,
        name: food.name,
        detail: [food.brand, `${food.per_100.kcal} kcal/100`].filter(Boolean).join(' · '),
      })),
      ...found.remote
        .filter((food) => food.usable && !known.has(food.barcode))
        .map((food) => ({
          id: null,
          barcode: food.barcode,
          name: food.name,
          detail: [food.brand, 'Open Food Facts'].filter(Boolean).join(' · '),
        })),
    ];
    const warning = found.remote_error ? `Open Food Facts: ${found.remote_error}` : null;
    return { choices, warning };
  }

  private async recipes(text: string): Promise<Found> {
    const { recipes } = await this.api.view('recipes');
    const needle = text.toLowerCase();
    const choices = recipes
      .filter((recipe) => recipe.name.toLowerCase().includes(needle))
      .map((recipe) => ({
        id: recipe.id,
        barcode: null,
        name: recipe.name,
        detail: `${Math.round(recipe.per_portion.kcal ?? 0)} kcal/portion`,
      }));
    return { choices, warning: null };
  }

  private async loadName(id: string, request: number): Promise<void> {
    let name = id;
    try {
      const found =
        this.pick() === 'food'
          ? await this.api.view('food', { id })
          : await this.api.view('recipe', { id });
      name = found.name;
    } catch {
      name = id;
    }
    if (!this.destroyed && request === this.nameId) {
      this.chosenName.set(name);
    }
  }
}
