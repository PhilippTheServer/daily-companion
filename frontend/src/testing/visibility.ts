/** Make the document visible again, the way a browser does when the tab or app returns. */
export function becomeVisible(): void {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Pretend the document is hidden (no event is sent). */
export function hide(): void {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
}
