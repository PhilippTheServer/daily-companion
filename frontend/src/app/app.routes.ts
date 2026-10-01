import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth';
import { Callback } from './core/auth/callback';
import { SignedOut } from './core/auth/signed-out';

export const routes: Routes = [
  { path: 'callback', component: Callback },
  { path: 'signed-out', component: SignedOut },
  {
    path: '',
    canActivateChild: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'today' },
      {
        path: 'today',
        loadComponent: () => import('./features/today/today').then((m) => m.TodayPage),
      },
      {
        path: 'day/:date',
        loadComponent: () => import('./features/day/day').then((m) => m.DayPage),
      },
      {
        path: 'diary',
        loadComponent: () => import('./features/diary/diary').then((m) => m.DiaryPage),
      },
      {
        path: 'event/:chain',
        loadComponent: () => import('./features/event/event').then((m) => m.EventPage),
      },
      {
        path: 'log/:kind',
        loadComponent: () => import('./features/event/log').then((m) => m.LogPage),
      },
      {
        path: 'catalog',
        loadComponent: () => import('./features/catalog/catalog').then((m) => m.CatalogPage),
      },
      {
        path: 'catalog/food/:id',
        loadComponent: () => import('./features/catalog/food').then((m) => m.FoodPage),
      },
      {
        path: 'catalog/recipe/:id',
        loadComponent: () => import('./features/catalog/recipe').then((m) => m.RecipePage),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile').then((m) => m.ProfilePage),
      },
      { path: '**', redirectTo: 'today' },
    ],
  },
];
