import { TestBed } from '@angular/core/testing';
import { ApiError } from './api/errors';
import { Notices, NoticesView } from './notices';

describe('Notices', () => {
  afterEach(() => vi.useRealTimers());

  it('shows errors through errorText and hides notices after a while', () => {
    vi.useFakeTimers();
    const notices = TestBed.inject(Notices);
    notices.error(new ApiError('not_found', 'no chain c-9', 'chain_id', 404));
    notices.warnings(['goal date not reachable at a safe pace']);
    expect(notices.items().map((item) => [item.tone, item.text])).toEqual([
      ['error', 'Not found: no chain c-9'],
      ['info', 'goal date not reachable at a safe pace'],
    ]);
    vi.advanceTimersByTime(4000);
    expect(notices.items()).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(notices.items()).toHaveLength(0);
  });

  it('announces errors as alerts and other notices politely', async () => {
    const notices = TestBed.inject(Notices);
    notices.show('saved');
    notices.show('failed', 'error');
    const fixture = TestBed.createComponent(NoticesView);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map((b) => [b.className, b.getAttribute('role')])).toEqual([
      ['info', null],
      ['error', 'alert'],
    ]);
    expect(root.querySelector('.notices')?.getAttribute('aria-live')).toBe('polite');
  });
});
