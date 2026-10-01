import { Directive, ElementRef, OnDestroy, OnInit, inject, output } from '@angular/core';

/**
 * Emits once when the element scrolls into view, then stops observing until the consumer calls
 * `rearm()`; does nothing where IntersectionObserver is missing. Re-arming after each finished
 * load makes a sentinel that is still in range emit again, and never while an error shows.
 */
@Directive({ selector: '[appVisible]' })
export class Visible implements OnInit, OnDestroy {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private observer: IntersectionObserver | null = null;
  private armed = false;

  readonly appVisible = output<void>();

  ngOnInit(): void {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (this.armed && entries.some((entry) => entry.isIntersecting)) {
          this.armed = false;
          this.observer?.unobserve(this.element.nativeElement);
          this.appVisible.emit();
        }
      },
      { rootMargin: '400px 0px' },
    );
    this.rearm();
  }

  /** Observe again; the next intersection (including one already in progress) emits. */
  rearm(): void {
    if (this.observer && !this.armed) {
      this.armed = true;
      this.observer.observe(this.element.nativeElement);
    }
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
