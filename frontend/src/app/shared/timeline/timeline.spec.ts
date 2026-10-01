import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { event } from '../../../testing/events';
import { Timeline } from './timeline';

declare const process: { env: Record<string, string | undefined> };

/** Runs `body` with the process time zone set to `zone`; Node re-reads TZ on every assignment. */
async function inZone(zone: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env['TZ'];
    } else {
      process.env['TZ'] = previous;
    }
  }
}

describe('Timeline', () => {
  it('renders one linked, time-stamped row per event with source and edit badges', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Timeline);
    fixture.componentRef.setInput('events', [
      event({ id: 'a', chain_id: 'chain-a', occurred_at: '2026-09-29T08:15:00Z' }),
      event({
        id: 'b',
        chain_id: 'chain-b',
        occurred_at: '2026-09-29T12:30:00Z',
        source: 'claude',
        version: 2,
      }),
    ]);
    await fixture.whenStable();
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('/event/chain-a');
    expect(rows[0].querySelector('.badge')).toBeNull();
    expect(rows[1].querySelector('time')!.getAttribute('datetime')).toBe('2026-09-29T12:30:00Z');
    expect([...rows[1].querySelectorAll('.badge')].map((b) => b.textContent)).toEqual([
      'claude',
      'edited',
    ]);
  });

  it('says so when there is nothing', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Timeline);
    fixture.componentRef.setInput('events', []);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Nothing logged yet.');
  });

  async function render(events: ReturnType<typeof event>[]): Promise<HTMLElement> {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Timeline);
    fixture.componentRef.setInput('events', events);
    await fixture.whenStable();
    return fixture.nativeElement;
  }

  it('shows HH:mm in the browser time zone', async () => {
    await inZone('Asia/Kolkata', async () => {
      const element = await render([event({ occurred_at: '2026-09-29T08:15:00Z' })]);
      expect(element.querySelector('time')!.textContent).toBe('13:45');
    });
    TestBed.resetTestingModule();
    await inZone('America/New_York', async () => {
      const element = await render([event({ occurred_at: '2026-09-29T08:15:00Z' })]);
      expect(element.querySelector('time')!.textContent).toBe('04:15');
    });
  });

  it('shows no edited badge at version 1 and one from version 2', async () => {
    const element = await render([event({ id: 'a', version: 1 }), event({ id: 'b', version: 3 })]);
    const rows = [...element.querySelectorAll('li')];
    expect(rows[0].textContent).not.toContain('edited');
    expect(rows[1].querySelector('.badge')!.textContent).toBe('edited');
  });

  it('exposes the kind of each row', async () => {
    const element = await render([
      event({ id: 'a', kind: 'note' }),
      event({ id: 'b', kind: 'sleep', payload: {} }),
    ]);
    expect([...element.querySelectorAll('li')].map((li) => li.getAttribute('data-kind'))).toEqual([
      'note',
      'sleep',
    ]);
  });

  it('marks a retracted event with a badge and the retracted class', async () => {
    const element = await render([event({ retracted: true }), event({ id: 'b' })]);
    const rows = [...element.querySelectorAll('li')];
    expect(rows[0].classList).toContain('retracted');
    expect([...rows[0].querySelectorAll('.badge')].map((b) => b.textContent)).toEqual([
      'retracted',
    ]);
    expect(rows[1].classList).not.toContain('retracted');
    expect(rows[1].querySelector('.badge')).toBeNull();
  });

  it('separates adjacent badges with whitespace', async () => {
    const element = await render([event({ source: 'claude', version: 2, retracted: true })]);
    expect(element.querySelector('.meta')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'claude edited retracted',
    );
  });
});
