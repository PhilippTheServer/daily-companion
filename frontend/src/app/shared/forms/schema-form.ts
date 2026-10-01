import { Component, input, model } from '@angular/core';
import { Edit, FieldView } from './field-view';
import { Field, updateIn } from './schema';

/** A form generated from a JSON Schema field tree; `value` is two-way bound. */
@Component({
  selector: 'app-schema-form',
  imports: [FieldView],
  template: `
    <app-field
      [field]="field()"
      [value]="value()"
      [edit]="edit"
      [errorPath]="errorPath()"
      [errorMessage]="errorMessage()"
    />
  `,
})
export class SchemaForm {
  readonly field = input.required<Field>();
  readonly value = model.required<Record<string, unknown>>();
  readonly errorPath = input<string | null>(null);
  readonly errorMessage = input('');

  protected readonly edit: Edit = (path, change) =>
    this.value.update((root) => updateIn(root, path, change) as Record<string, unknown>);
}
