import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Api } from '../../core/api/api';
import { CommandForm } from '../../shared/forms/command-form';
import { recipe } from '../../../testing/catalog';
import { provideFeatureTesting, request } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import { RecipePage } from './recipe';

describe('RecipePage', () => {
  it('shows per-portion nutrients and saves an edit as a new version', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(RecipePage);
    fixture.componentRef.setInput('id', 'recipe-1');
    (await request('/api/v2/views/recipe')).flush(recipe());
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('Per portion: 228 kcal');
    });
    expect(element.querySelectorAll('.items tbody tr')).toHaveLength(2);
    expect(element.querySelectorAll('.items th[scope="col"]')).toHaveLength(3);

    [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit')!.click();
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('form')).not.toBeNull();
    });
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    expect((await request('/api/v2/commands/save_recipe')).request.body).toEqual({
      id: 'recipe-1',
      name: 'Overnight oats',
      serves: 2,
      steps: ['Mix', 'Wait overnight'],
      items: [
        { food_id: 'food-1', grams: 250 },
        { food_id: 'food-2', grams: 80 },
      ],
      note: null,
      idempotency_key: expect.any(String),
    });
  });

  async function editing() {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(RecipePage);
    fixture.componentRef.setInput('id', 'recipe-1');
    (await request('/api/v2/views/recipe')).flush(recipe());
    const element: HTMLElement = fixture.nativeElement;
    const edit = () =>
      [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit')!;
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(edit()).toBeTruthy();
    });
    return { fixture, element, edit };
  }

  const openForm = async (page: Awaited<ReturnType<typeof editing>>, first = true) => {
    page.edit().click();
    if (first) {
      (await request('/api/v2/schemas')).flush(SCHEMAS);
    }
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      expect(page.element.querySelector('[name="name"]')).not.toBeNull();
    });
    return page.element.querySelector<HTMLInputElement>('[name="name"]')!;
  };

  it('keeps what was typed when another command reloads the recipe', async () => {
    const page = await editing();
    const name = await openForm(page);
    name.value = 'Typed name';
    name.dispatchEvent(new Event('input'));
    const api = TestBed.inject(Api);
    const other = api.command('archive_food', { id: 'food-9', idempotency_key: 'k' });
    (await request('/api/v2/commands/archive_food')).flush({
      result: {},
      warnings: [],
      days: [],
    });
    await other;
    (await request('/api/v2/views/recipe')).flush(recipe({ name: 'Reloaded' }));
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      TestBed.tick();
    });
    expect(page.element.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('Typed name');
  });

  it('blocks Edit until the reload after a save lands, then shows the saved values', async () => {
    const page = await editing();
    const name = await openForm(page);
    name.value = 'Saved name';
    name.dispatchEvent(new Event('input'));
    page.element.querySelector('form')!.dispatchEvent(new Event('submit'));
    (await request('/api/v2/commands/save_recipe')).flush({
      result: recipe({ name: 'Saved name' }),
      warnings: [],
      days: [],
    });
    const reload = await request('/api/v2/views/recipe');
    await vi.waitFor(() => {
      TestBed.tick();
      expect(page.element.querySelector('form')).toBeNull();
      expect(page.edit().disabled).toBe(true);
    });
    reload.flush(recipe({ name: 'Saved name' }));
    await vi.waitFor(async () => {
      await page.fixture.whenStable();
      TestBed.tick();
      expect(page.edit().disabled).toBe(false);
    });
    expect((await openForm(page, false)).value).toBe('Saved name');
  });

  const boom = { status: 500, statusText: 'Server Error' };

  it('shows an unknown id as an alert without throwing', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(RecipePage);
    fixture.componentRef.setInput('id', 'nope');
    (await request('/api/v2/views/recipe')).flush({ title: 'Not found' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
        'HTTP 500',
      );
    });
  });

  it('archives once and shows the archived state', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(RecipePage);
    fixture.componentRef.setInput('id', 'recipe-1');
    (await request('/api/v2/views/recipe')).flush(recipe());
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('h1')!.textContent).toBe('Overnight oats');
    });
    const archive = () =>
      [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Archive');
    archive()!.click();
    archive()!.click();
    const call = await request('/api/v2/commands/archive_recipe');
    expect(call.request.body).toEqual({ id: 'recipe-1', idempotency_key: expect.any(String) });
    call.flush({ result: recipe({ archived: true }), effects: { days: [] }, warnings: [] });
    (await request('/api/v2/views/recipe')).flush(recipe({ archived: true }));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('archived');
      expect(archive()).toBeUndefined();
    });
  });

  it('opens the create form for /catalog/recipe/new', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(RecipePage);
    fixture.componentRef.setInput('id', 'new');
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('h1')!.textContent).toBe('New recipe');
      expect(fixture.nativeElement.querySelector('form')).not.toBeNull();
    });
  });

  it('navigates to the created recipe after saving a new one', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(RecipePage);
    fixture.componentRef.setInput('id', 'new');
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(fixture.debugElement.query(By.directive(CommandForm))).not.toBeNull();
    });
    fixture.debugElement
      .query(By.directive(CommandForm))
      .componentInstance.done.emit(recipe({ id: 'recipe-9' }));
    expect(navigate).toHaveBeenCalledWith(['/catalog/recipe', 'recipe-9'], { replaceUrl: true });
  });

  it('clears a failed archive when the id changes', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(RecipePage);
    fixture.componentRef.setInput('id', 'recipe-1');
    (await request('/api/v2/views/recipe')).flush(recipe());
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('h1')).not.toBeNull();
    });
    [...element.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Archive')!
      .click();
    (await request('/api/v2/commands/archive_recipe')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')).not.toBeNull();
    });
    fixture.componentRef.setInput('id', 'recipe-2');
    (
      await request((r) => r.url === '/api/v2/views/recipe' && r.params.get('id') === 'recipe-2')
    ).flush(recipe({ id: 'recipe-2' }));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')).toBeNull();
    });
  });
});
