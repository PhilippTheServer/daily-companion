import { Component, computed, input } from '@angular/core';
import { fromLocalInput, toLocalInput } from '../time';
import { FoodPicker } from './food-picker';
import { Field, Path, humanize, initialValue } from './schema';

/** Applies a change at a path to the whole form value. */
export type Edit = (path: Path, change: (current: unknown) => unknown) => void;

let nextId = 0;

/** One generated input; objects and arrays render their children with this component again. */
@Component({
  selector: 'app-field',
  imports: [FoodPicker],
  template: `
    @let f = field();
    @switch (f.widget) {
      @case ('object') {
        <fieldset [class.invalid]="invalid()">
          @if (f.key) {
            <legend>{{ f.label }}</legend>
          }
          @if (record(); as current) {
            @for (child of f.fields; track child.key) {
              <app-field
                [field]="child"
                [value]="current[child.key]"
                [path]="at(child.key)"
                [edit]="edit()"
                [errorPath]="errorPath()"
                [errorMessage]="errorMessage()"
              />
            }
            @if (f.nullable) {
              <button type="button" class="link" (click)="set(null)">Remove {{ f.label }}</button>
            }
          } @else {
            <button type="button" class="link" (click)="set(fresh(f))">Add {{ f.label }}</button>
          }
        </fieldset>
      }
      @case ('array') {
        <fieldset [class.invalid]="invalid()">
          <legend>{{ f.label }}</legend>
          @for (item of list(); track $index) {
            <div class="array-item">
              <app-field
                [field]="f.item!"
                [value]="item"
                [path]="at($index)"
                [edit]="edit()"
                [errorPath]="errorPath()"
                [errorMessage]="errorMessage()"
              />
              <button type="button" class="link" (click)="removeIndex($index)">Remove</button>
            </div>
          }
          @if (f.maxItems === null || list().length < f.maxItems) {
            <button type="button" class="link" (click)="append()">Add</button>
          }
        </fieldset>
      }
      @case ('multi-enum') {
        <fieldset [class.invalid]="invalid()">
          <legend>{{ f.label }}</legend>
          @for (option of f.item!.options; track option) {
            <label class="check">
              <input
                type="checkbox"
                [attr.name]="name()"
                [checked]="list().includes(option)"
                (change)="toggle(option)"
              />
              {{ words(option) }}
            </label>
          }
        </fieldset>
      }
      @case ('food-picker') {
        <div role="group" [class.invalid]="invalid()" [attr.aria-labelledby]="labelId">
          <span class="label" [id]="labelId"
            >{{ f.label }}
            @if (f.required) {
              <b aria-hidden="true"> *</b>
            }
          </span>
          <app-food-picker
            [pick]="f.pick!"
            [value]="value()"
            [name]="name()"
            (picked)="set($event)"
          />
          @if (f.hint) {
            <small class="hint">{{ f.hint }}</small>
          }
        </div>
      }
      @default {
        <label [class.invalid]="invalid()">
          <span class="label"
            >{{ f.label }}
            @if (f.required) {
              <b aria-hidden="true"> *</b>
            }
          </span>
          @switch (f.widget) {
            @case ('enum') {
              <select
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                (change)="emitText($any($event.target).value)"
              >
                <option value="" [selected]="value() == null">–</option>
                @for (option of f.options; track option) {
                  <option [value]="option" [selected]="value() === option">
                    {{ words(option) }}
                  </option>
                }
              </select>
            }
            @case ('boolean') {
              <input
                type="checkbox"
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                [checked]="value() === true"
                (change)="set($any($event.target).checked)"
              />
            }
            @case ('text') {
              <textarea
                rows="3"
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                [attr.maxlength]="f.maxLength"
                [value]="value() ?? ''"
                (input)="emitText($any($event.target).value)"
              ></textarea>
            }
            @case ('date-time') {
              <input
                type="datetime-local"
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                [value]="value() ? local(value()) : ''"
                (change)="emitDateTime($any($event.target).value)"
              />
            }
            @case ('date') {
              <input
                type="date"
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                [value]="value() ?? ''"
                (change)="emitText($any($event.target).value)"
              />
            }
            @case ('number') {
              <input
                type="number"
                inputmode="decimal"
                step="any"
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                [attr.min]="f.min"
                [attr.max]="f.max"
                [value]="value() ?? ''"
                (input)="emitNumber($any($event.target).value)"
              />
            }
            @case ('integer') {
              <input
                type="number"
                inputmode="numeric"
                step="1"
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                [attr.min]="f.min"
                [attr.max]="f.max"
                [value]="value() ?? ''"
                (input)="emitNumber($any($event.target).value)"
              />
            }
            @default {
              <input
                type="text"
                [attr.name]="name()"
                [attr.aria-invalid]="invalid() || null"
                [attr.aria-describedby]="invalid() ? errorId : null"
                [attr.maxlength]="f.maxLength"
                [attr.pattern]="f.pattern"
                [value]="value() ?? ''"
                (input)="emitText($any($event.target).value)"
              />
            }
          }
          @if (bounds(); as text) {
            <small class="bound">{{ text }}</small>
          }
          @if (f.hint) {
            <small class="hint">{{ f.hint }}</small>
          }
        </label>
      }
    }
    @if (invalid()) {
      <p class="field-error" [id]="errorId">{{ errorMessage() }}</p>
    }
  `,
})
export class FieldView {
  readonly field = input.required<Field>();
  readonly value = input<unknown>(null);
  readonly path = input<Path>([]);
  readonly edit = input.required<Edit>();
  readonly errorPath = input<string | null>(null);
  readonly errorMessage = input('');

  private readonly uid = `field-${nextId++}`;
  protected readonly labelId = `${this.uid}-label`;
  protected readonly errorId = `${this.uid}-error`;
  protected readonly name = computed(() => this.path().join('.'));
  protected readonly invalid = computed(
    () => this.errorPath() !== null && this.errorPath() === this.name(),
  );
  protected readonly record = computed(() => {
    const value = this.value();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  });
  protected readonly list = computed(() => {
    const value = this.value();
    return Array.isArray(value) ? (value as unknown[]) : [];
  });
  protected readonly bounds = computed(() => {
    const f = this.field();
    const parts = [
      f.exclusiveMin && f.min !== null ? `> ${f.min}` : null,
      f.exclusiveMax && f.max !== null ? `< ${f.max}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  });
  protected readonly words = humanize;
  protected readonly fresh = initialValue;
  protected readonly local = (value: unknown) => toLocalInput(String(value));

  protected at(key: string | number): Path {
    return [...this.path(), key];
  }

  protected set(value: unknown): void {
    this.edit()(this.path(), () => value);
  }

  protected removeIndex(index: number): void {
    this.edit()(this.path(), (current) =>
      (Array.isArray(current) ? current : []).filter((_, at) => at !== index),
    );
  }

  protected append(): void {
    const item = initialValue(this.field().item!);
    this.edit()(this.path(), (current) => [...(Array.isArray(current) ? current : []), item]);
  }

  protected toggle(option: string): void {
    this.edit()(this.path(), (current) => {
      const list = Array.isArray(current) ? current : [];
      return list.includes(option) ? list.filter((item) => item !== option) : [...list, option];
    });
  }

  protected emitText(text: string): void {
    this.set(text === '' ? null : text);
  }

  protected emitNumber(text: string): void {
    this.set(text === '' ? null : Number(text));
  }

  protected emitDateTime(text: string): void {
    this.set(text === '' ? null : fromLocalInput(text));
  }
}
