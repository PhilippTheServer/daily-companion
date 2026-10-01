import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Api } from '../../core/api/api';
import { CommandForm } from '../../shared/forms/command-form';
import { food } from '../../../testing/catalog';
import { provideFeatureTesting, request } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import { FoodPage } from './food';

describe('FoodPage', () => {
  it('shows facts per 100 g and the version count, and archives', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(FoodPage);
    fixture.componentRef.setInput('id', 'food-1');
    (await request('/api/v2/views/food')).flush(food());
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('h1')!.textContent).toBe('Skyr');
    });
    expect(element.textContent).toContain('Open Food Facts · version 2');
    expect(element.querySelector('.rows')!.textContent).toContain('Protein (g)');
    expect(element.querySelector('.rows')!.textContent).not.toContain('Fiber');
    [...element.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Archive')!
      .click();
    expect((await request('/api/v2/commands/archive_food')).request.body).toEqual({
      id: 'food-1',
      idempotency_key: expect.any(String),
    });
  });

  const boom = { status: 500, statusText: 'Server Error' };

  async function open(id = 'food-1') {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(FoodPage);
    fixture.componentRef.setInput('id', id);
    const element: HTMLElement = fixture.nativeElement;
    return { fixture, element };
  }

  it('shows an unknown id as an alert without throwing', async () => {
    const { element } = await open('nope');
    (await request('/api/v2/views/food')).flush({ title: 'Not found' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
  });

  it('archives once, shows the archived state and offers no second click', async () => {
    const { fixture, element } = await open();
    (await request('/api/v2/views/food')).flush(food());
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('h1')!.textContent).toBe('Skyr');
    });
    const archive = () =>
      [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Archive');
    archive()!.click();
    archive()!.click();
    const call = await request('/api/v2/commands/archive_food');
    TestBed.tick();
    expect(archive()!.disabled).toBe(true);
    call.flush({ result: food({ archived: true }), effects: { days: [] }, warnings: [] });
    (await request('/api/v2/views/food')).flush(food({ archived: true }));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('archived');
      expect(archive()).toBeUndefined();
    });
  });

  it('shows a failed archive inline and retries with the same key', async () => {
    const { fixture, element } = await open();
    (await request('/api/v2/views/food')).flush(food());
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('h1')).not.toBeNull();
    });
    const archive = () =>
      [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Archive')!;
    archive().click();
    const first = await request('/api/v2/commands/archive_food');
    const key = (first.request.body as { idempotency_key: string }).idempotency_key;
    first.flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
    archive().click();
    const second = await request('/api/v2/commands/archive_food');
    expect((second.request.body as { idempotency_key: string }).idempotency_key).toBe(key);
  });

  it('opens the create form for /catalog/food/new without loading a food', async () => {
    const { fixture, element } = await open('new');
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('h1')!.textContent).toBe('New food');
      expect(element.querySelector('form')).not.toBeNull();
    });
  });

  it('navigates to the created food after saving a new one', async () => {
    const { fixture } = await open('new');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(fixture.debugElement.query(By.directive(CommandForm))).not.toBeNull();
    });
    fixture.debugElement
      .query(By.directive(CommandForm))
      .componentInstance.done.emit(food({ id: 'food-9' }));
    expect(navigate).toHaveBeenCalledWith(['/catalog/food', 'food-9'], { replaceUrl: true });
  });

  it('clears a failed archive when the id changes', async () => {
    const { fixture, element } = await open();
    (await request('/api/v2/views/food')).flush(food());
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('h1')).not.toBeNull();
    });
    [...element.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Archive')!
      .click();
    (await request('/api/v2/commands/archive_food')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')).not.toBeNull();
    });
    fixture.componentRef.setInput('id', 'food-2');
    (await request((r) => r.url === '/api/v2/views/food' && r.params.get('id') === 'food-2')).flush(
      food({ id: 'food-2' }),
    );
    await vi.waitFor(async () => {
      await fixture.whenStable();
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')).toBeNull();
    });
  });
  async function editing() {
    const page = await open();
    (await request('/api/v2/views/food')).flush(food());
    const edit = () =>
      [...page.element.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit')!;
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      expect(edit()).toBeTruthy();
    });
    return { ...page, edit };
  }

  const openForm = async (page: Awaited<ReturnType<typeof editing>>) => {
    page.edit().click();
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      expect(page.element.querySelector('[name="name"]')).not.toBeNull();
    });
    return page.element.querySelector<HTMLInputElement>('[name="name"]')!;
  };

  it('sends save_food with the fixed id when an edit is saved', async () => {
    const page = await editing();
    const name = await openForm(page);
    name.value = 'Skyr natural';
    name.dispatchEvent(new Event('input'));
    page.element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const body = (await request('/api/v2/commands/save_food')).request.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ id: 'food-1', name: 'Skyr natural' });
    expect(body['idempotency_key']).toEqual(expect.any(String));
  });

  it('keeps what was typed when another command reloads the food', async () => {
    const page = await editing();
    const name = await openForm(page);
    name.value = 'Typed name';
    name.dispatchEvent(new Event('input'));
    const other = TestBed.inject(Api).command('archive_food', {
      id: 'food-9',
      idempotency_key: 'k',
    });
    (await request('/api/v2/commands/archive_food')).flush({
      result: {},
      warnings: [],
      days: [],
    });
    await other;
    (await request('/api/v2/views/food')).flush(food({ name: 'Reloaded' }));
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      TestBed.tick();
    });
    expect(page.element.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('Typed name');
  });

  it('disables Edit while the food is loading', async () => {
    const page = await editing();
    TestBed.inject(Api).revision.update((value) => value + 1);
    const reload = await request('/api/v2/views/food');
    await vi.waitFor(() => {
      TestBed.tick();
      expect(page.edit().disabled).toBe(true);
    });
    reload.flush(food());
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      TestBed.tick();
      expect(page.edit().disabled).toBe(false);
    });
  });
});
