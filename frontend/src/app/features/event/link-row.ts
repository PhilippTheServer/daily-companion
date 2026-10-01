import { Component, computed, inject, input, output, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { LinkOut, Relation } from '../../core/api/types';
import { describeEvent } from '../../shared/timeline/describe';
import { clock, dayLabel } from '../../shared/time';

const LABELS: Record<Relation, Record<LinkOut['direction'], string>> = {
  suspected_cause: { outgoing: 'Suspected cause', incoming: 'Suspected cause of' },
  part_of: { outgoing: 'Part of', incoming: 'Has part' },
  follows: { outgoing: 'Follows', incoming: 'Followed by' },
};

/** One link of an event: the relation, the other event (loaded by chain) and an unlink button. */
@Component({
  selector: 'app-link-row',
  imports: [RouterLink],
  template: `
    <span class="relation">{{ relation() }}</span>
    @if (target.error(); as failed) {
      <span class="form-error" role="alert">{{ text(failed) }}</span>
    } @else {
      <a [routerLink]="['/event', link().chain_id]">{{ other() }}</a>
    }
    <button
      type="button"
      class="link"
      [attr.aria-label]="'Unlink ' + other()"
      [disabled]="busy()"
      (click)="unlink.emit(link())"
    >
      Unlink
    </button>
  `,
})
export class LinkRow {
  private readonly api = inject(Api);

  readonly link = input.required<LinkOut>();
  readonly busy = input(false);
  readonly unlink = output<LinkOut>();

  protected readonly text = errorText;

  protected readonly target = resource({
    params: () => ({ chain_id: this.link().chain_id }),
    loader: ({ params }) => this.api.view('event', params),
  });
  protected readonly relation = computed(() => {
    const { relation, direction } = this.link();
    return `${LABELS[relation][direction]}:`;
  });
  protected readonly other = computed(() => {
    const head = this.target.hasValue() ? this.target.value().versions.at(-1) : undefined;
    if (!head) {
      return '…';
    }
    return `${describeEvent(head).title} (${dayLabel(head.local_day)} ${clock(head.occurred_at)})`;
  });

  constructor() {
    reloadAfterCommands(this.target);
  }
}
