import { TestBed } from '@angular/core/testing';
import type { DaySummary } from '../../core/api/types';
import { DaySummaryView } from './day-summary';

const EMPTY = {
  fluid_ml: 0,
  sleep: null,
  steps: null,
  weight_kg: null,
  workouts: { count: 0, minutes: 0 },
  symptoms: [],
  outtake_count: 0,
  gauges: [{ name: 'kcal', value: 0, target: 2300, ratio: 0 }],
} as unknown as DaySummary;

describe('DaySummaryView', () => {
  async function render(overrides: Partial<DaySummary>): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(DaySummaryView);
    fixture.componentRef.setInput('summary', { ...EMPTY, ...overrides });
    await fixture.whenStable();
    return fixture.nativeElement;
  }

  it('renders a gauge per entry and no facts line for an empty day', async () => {
    const element = await render({});
    expect(element.querySelectorAll('app-gauge')).toHaveLength(1);
    expect(element.querySelector('.facts')).toBeNull();
  });

  it('lists the other totals in one line', async () => {
    const element = await render({
      fluid_ml: 1499.6,
      sleep: { hours: 7.333, quality: 4, stages: null },
      steps: { steps: 8123, source: 'watch' },
      weight_kg: 81.4,
      workouts: { count: 2, minutes: 74.4 },
      outtake_count: 3,
      symptoms: [{ type: 'stomach_ache', count: 2, max_severity: 3 }],
    });
    expect(element.querySelector('.facts')!.textContent).toBe(
      '1500 ml fluid · 7.3 h sleep · 8123 steps · 81.4 kg · 2 workouts, 74 min · 3 bowel movements · Stomach ache ×2',
    );
  });

  it('uses the singular for one workout and one bowel movement', async () => {
    const element = await render({ workouts: { count: 1, minutes: 30 }, outtake_count: 1 });
    expect(element.querySelector('.facts')!.textContent).toBe(
      '1 workout, 30 min · 1 bowel movement',
    );
  });
});
