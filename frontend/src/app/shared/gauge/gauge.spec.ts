import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { Gauge } from '../../core/api/types';
import { GaugeView } from './gauge';

describe('GaugeView', () => {
  let fixture: ComponentFixture<GaugeView>;

  async function render(gauge: Gauge): Promise<HTMLElement> {
    fixture = TestBed.createComponent(GaugeView);
    fixture.componentRef.setInput('gauge', gauge);
    await fixture.whenStable();
    return fixture.nativeElement;
  }

  const stateOf = (element: HTMLElement) =>
    element.querySelector('.gauge')!.getAttribute('data-state');
  const meterOf = (element: HTMLElement) => element.querySelector('[role="meter"]')!;

  it('shows value, remainder and a proportional fill', async () => {
    const element = await render({ name: 'kcal', value: 1450.4, target: 2300, ratio: 0.63 });
    expect(element.querySelector('.name')!.textContent).toBe('Energy');
    expect(element.querySelector('.value')!.textContent).toBe('1450 kcal');
    expect(element.querySelector('.rest')!.textContent).toBe('850 kcal left of 2300');
    expect(element.querySelector<HTMLElement>('.fill')!.style.width).toBe('63%');
    expect(stateOf(element)).toBe('under');
  });

  it('caps the fill and says how far over the target it is', async () => {
    const element = await render({ name: 'fat', value: 95, target: 70, ratio: 1.36 });
    expect(element.querySelector<HTMLElement>('.fill')!.style.width).toBe('100%');
    expect(element.querySelector('.rest')!.textContent).toBe('25 g over 70');
    expect(stateOf(element)).toBe('over');
  });

  it('says when there is no target', async () => {
    const element = await render({ name: 'protein', value: 40, target: null, ratio: null });
    expect(element.querySelector('.rest')!.textContent).toBe('no target');
    expect(stateOf(element)).toBe('none');
  });

  it('treats a target of 0 like no target', async () => {
    const element = await render({ name: 'carbs', value: 40, target: 0, ratio: 0 });
    expect(element.querySelector('.rest')!.textContent).toBe('no target');
    expect(stateOf(element)).toBe('none');
    const meter = meterOf(element);
    expect(meter.hasAttribute('aria-valuenow')).toBe(false);
    expect(meter.hasAttribute('aria-valuemin')).toBe(false);
    expect(meter.hasAttribute('aria-valuemax')).toBe(false);
    expect(meter.getAttribute('aria-valuetext')).toBe('no target');
  });

  it('treats an undefined target like null', async () => {
    const element = await render({ name: 'carbs', value: 40 } as Gauge);
    expect(element.querySelector('.rest')!.textContent).toBe('no target');
    expect(stateOf(element)).toBe('none');
  });

  it('labels the meter with min, max, a clamped value and the visible text', async () => {
    const element = await render({ name: 'fat', value: 95, target: 70, ratio: 1.36 });
    const meter = meterOf(element);
    expect(meter.getAttribute('aria-label')).toBe('Fat');
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('70');
    expect(meter.getAttribute('aria-valuenow')).toBe('70');
    expect(meter.getAttribute('aria-valuetext')).toBe('25 g over 70');
  });

  it('keeps the value in range while under the target', async () => {
    const element = await render({ name: 'kcal', value: 1450.4, target: 2300, ratio: 0.63 });
    const meter = meterOf(element);
    expect(meter.getAttribute('aria-valuenow')).toBe('1450.4');
    expect(meter.getAttribute('aria-valuetext')).toBe('850 kcal left of 2300');
  });

  it('shows the g unit for protein, carbs and fat', async () => {
    for (const [name, label] of [
      ['protein', 'Protein'],
      ['carbs', 'Carbs'],
      ['fat', 'Fat'],
    ] as const) {
      const element = await render({ name, value: 12.4, target: 50, ratio: 0.25 });
      expect(element.querySelector('.name')!.textContent).toBe(label);
      expect(element.querySelector('.value')!.textContent).toBe('12 g');
      expect(element.querySelector('.rest')!.textContent).toBe('38 g left of 50');
    }
  });

  it('is near within 10 % of the target and under or over outside it', async () => {
    const states: [number, string][] = [
      [0.89, 'under'],
      [0.9, 'near'],
      [1.0, 'near'],
      [1.1, 'near'],
      [1.11, 'over'],
    ];
    for (const [ratio, state] of states) {
      const element = await render({ name: 'kcal', value: ratio * 100, target: 100, ratio });
      expect(stateOf(element), `ratio ${ratio}`).toBe(state);
    }
  });
});
