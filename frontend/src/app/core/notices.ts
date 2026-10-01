import { Component, Injectable, inject, signal } from '@angular/core';
import { errorText } from './api/errors';

export interface Notice {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const VISIBLE_MS = { info: 4000, error: 8000 };

/** Short messages at the bottom of the screen: command warnings and errors outside forms. */
@Injectable({ providedIn: 'root' })
export class Notices {
  private next = 0;
  readonly items = signal<Notice[]>([]);

  show(text: string, tone: Notice['tone'] = 'info'): void {
    const id = ++this.next;
    this.items.update((items) => [...items, { id, text, tone }]);
    setTimeout(() => this.dismiss(id), VISIBLE_MS[tone]);
  }

  error(error: unknown): void {
    this.show(errorText(error), 'error');
  }

  /** Show the warnings a command answered with. */
  warnings(warnings: string[] = []): void {
    for (const warning of warnings) {
      this.show(warning);
    }
  }

  dismiss(id: number): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }
}

/** Renders the notices; placed once in the shell. */
@Component({
  selector: 'app-notices',
  template: `
    <div class="notices" aria-live="polite">
      @for (notice of notices.items(); track notice.id) {
        <button
          type="button"
          [class]="notice.tone"
          [attr.role]="notice.tone === 'error' ? 'alert' : null"
          (click)="notices.dismiss(notice.id)"
        >
          {{ notice.text }}
        </button>
      }
    </div>
  `,
  styles: `
    .notices {
      position: fixed;
      inset: auto 1rem calc(4.5rem + env(safe-area-inset-bottom)) 1rem;
      display: grid;
      gap: 0.5rem;
      max-width: 38rem;
      margin: 0 auto;
      z-index: 10;
    }
    button {
      text-align: left;
      padding: 0.75rem 1rem;
      border-radius: 0.75rem;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink);
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
    }
    .error {
      border-color: var(--critical);
    }
  `,
})
export class NoticesView {
  protected readonly notices = inject(Notices);
}
