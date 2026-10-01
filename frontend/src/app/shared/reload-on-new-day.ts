import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject } from '@angular/core';
import { localDay } from './time';

/**
 * Reload a view when the document becomes visible again on a later day than the last load,
 * so a page left open overnight does not keep showing yesterday. Call in an injection context.
 */
export function reloadOnNewDay(view: { reload(): boolean }): void {
  const document = inject(DOCUMENT);
  let loadedOn = localDay();
  const onChange = () => {
    const today = localDay();
    if (document.visibilityState === 'visible' && today !== loadedOn) {
      loadedOn = today;
      view.reload();
    }
  };
  document.addEventListener('visibilitychange', onChange);
  inject(DestroyRef).onDestroy(() => document.removeEventListener('visibilitychange', onChange));
}
