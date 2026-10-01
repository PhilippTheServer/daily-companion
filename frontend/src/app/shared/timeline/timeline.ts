import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { EventOut } from '../../core/api/types';
import { clock } from '../time';
import { describeEvent } from './describe';

/** Events as time-stamped rows, one below the other; a row opens the event. */
@Component({
  selector: 'app-timeline',
  imports: [RouterLink],
  template: `
    <ol class="timeline">
      @for (event of events(); track event.id) {
        @let line = describe(event);
        <li [attr.data-kind]="event.kind" [class.retracted]="event.retracted">
          <a [routerLink]="['/event', event.chain_id]">
            <time [attr.datetime]="event.occurred_at">{{ clock(event.occurred_at) }}</time>
            <span class="body">
              <span class="title">{{ line.title }}</span>
              <span class="detail">{{ line.detail }}</span>
            </span>
            <span class="meta">
              @if (event.source !== 'app') {
                <span class="badge">{{ event.source }}</span
                >&ngsp;
              }
              @if (event.version > 1) {
                <span class="badge">edited</span>&ngsp;
              }
              @if (event.retracted) {
                <span class="badge">retracted</span>
              }
            </span>
          </a>
        </li>
      } @empty {
        <li class="empty">{{ emptyText() }}</li>
      }
    </ol>
  `,
  styles: `
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li a {
      display: grid;
      grid-template-columns: 3.25rem 1fr auto;
      gap: 0.75rem;
      align-items: baseline;
      padding: 0.6rem 0.25rem;
      border-bottom: 1px solid var(--line);
      color: inherit;
      text-decoration: none;
    }
    time {
      font-variant-numeric: tabular-nums;
      color: var(--ink-2);
    }
    .body {
      display: grid;
      min-width: 0;
    }
    .title {
      font-weight: 500;
    }
    .detail {
      color: var(--ink-2);
      font-size: 0.875rem;
    }
    .badge {
      font-size: 0.7rem;
      padding: 0.1rem 0.4rem;
      border-radius: 1rem;
      background: var(--track);
      color: var(--ink-2);
      margin-left: 0.25rem;
    }
    .retracted .body {
      text-decoration: line-through;
    }
    .empty {
      color: var(--ink-2);
      padding: 1rem 0.25rem;
    }
  `,
})
export class Timeline {
  readonly events = input.required<EventOut[]>();
  readonly emptyText = input('Nothing logged yet.');

  protected readonly clock = clock;
  protected readonly describe = describeEvent;
}
