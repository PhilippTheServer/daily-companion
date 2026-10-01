import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NoticesView } from './core/notices';

/** The shell: the current screen above a bottom navigation bar. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NoticesView],
  template: `
    <main><router-outlet /></main>
    <app-notices />
    <nav class="tabs" aria-label="Main">
      <a routerLink="/today" routerLinkActive="active">Today</a>
      <a routerLink="/diary" routerLinkActive="active">Diary</a>
      <a routerLink="/catalog" routerLinkActive="active">Catalog</a>
      <a routerLink="/profile" routerLinkActive="active">Profile</a>
    </nav>
  `,
  styles: `
    main {
      max-width: 40rem;
      margin: 0 auto;
      padding: 1rem 1rem 5rem;
    }
    .tabs {
      position: fixed;
      inset: auto 0 0 0;
      display: flex;
      justify-content: space-around;
      padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom));
      background: var(--surface);
      border-top: 1px solid var(--line);
    }
    .tabs a {
      color: var(--ink-2);
      text-decoration: none;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
    }
    .tabs a.active {
      color: var(--accent);
      font-weight: 600;
    }
  `,
})
export class App {}
