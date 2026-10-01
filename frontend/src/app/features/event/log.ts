import { Location } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { Kind } from '../../core/api/types';
import { InAppNavigation } from '../../core/navigation';
import { EventEditor } from '../../shared/forms/event-editor';
import { KINDS } from '../../shared/timeline/describe';

/** /log/:kind: a new event of one kind; back to where the user came from afterwards. */
@Component({
  selector: 'app-log',
  imports: [EventEditor, RouterLink],
  template: `
    @if (known()) {
      <app-event-editor [kind]="$any(kind())" (saved)="back()" (cancelled)="back()" />
    } @else {
      <p class="form-error" role="alert">
        Unknown kind "{{ kind() }}". <a routerLink="/today">Back to today</a>
      </p>
    }
  `,
})
export class LogPage {
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly navigation = inject(InAppNavigation);

  readonly kind = input.required<string>();

  protected readonly known = computed(() => KINDS.includes(this.kind() as Kind));

  protected back(): void {
    if (this.navigation.canGoBack) {
      this.location.back();
    } else {
      void this.router.navigateByUrl('/today');
    }
  }
}
