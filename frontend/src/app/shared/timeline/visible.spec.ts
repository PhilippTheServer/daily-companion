import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Visible } from './visible';

type Callback = (entries: { isIntersecting: boolean }[]) => void;

class StubObserver {
  static instances: StubObserver[] = [];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    readonly callback: Callback,
    readonly options: IntersectionObserverInit,
  ) {
    StubObserver.instances.push(this);
  }
}

@Component({
  imports: [Visible],
  template: `<div class="sentinel" (appVisible)="count = count + 1"></div>`,
})
class Host {
  count = 0;
}

describe('Visible', () => {
  beforeEach(() => {
    StubObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', StubObserver);
  });

  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return { fixture, observer: StubObserver.instances[0] };
  }

  it('observes its element 400 px before the viewport edge', () => {
    const { fixture, observer } = setup();
    expect(observer.options.rootMargin).toBe('400px 0px');
    expect(observer.observe).toHaveBeenCalledWith(fixture.nativeElement.querySelector('.sentinel'));
  });

  it('emits only when the element intersects', () => {
    const { fixture, observer } = setup();
    observer.callback([{ isIntersecting: false }]);
    expect(fixture.componentInstance.count).toBe(0);
    observer.callback([{ isIntersecting: true }]);
    expect(fixture.componentInstance.count).toBe(1);
  });

  it('emits once, then stays quiet until it is re-armed', () => {
    const { fixture, observer } = setup();
    const sentinel = fixture.nativeElement.querySelector('.sentinel');
    observer.callback([{ isIntersecting: true }]);
    expect(observer.unobserve).toHaveBeenCalledWith(sentinel);
    expect(observer.observe).toHaveBeenCalledTimes(1);
    observer.callback([{ isIntersecting: true }]);
    observer.callback([{ isIntersecting: true }]);
    expect(fixture.componentInstance.count).toBe(1);

    fixture.debugElement.children[0].injector.get(Visible).rearm();
    expect(observer.observe).toHaveBeenCalledTimes(2);
    observer.callback([{ isIntersecting: true }]);
    expect(fixture.componentInstance.count).toBe(2);
  });

  it('observes only once however often it is re-armed while armed', () => {
    const { fixture, observer } = setup();
    const visible = fixture.debugElement.children[0].injector.get(Visible);
    visible.rearm();
    visible.rearm();
    expect(observer.observe).toHaveBeenCalledTimes(1);
  });

  it('disconnects on destroy', () => {
    const { fixture, observer } = setup();
    fixture.destroy();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does nothing without IntersectionObserver', () => {
    vi.unstubAllGlobals();
    const fixture = TestBed.createComponent(Host);
    expect(() => fixture.detectChanges()).not.toThrow();
  });
});
