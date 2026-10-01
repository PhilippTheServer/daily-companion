import { HttpRequest } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { food, recipe } from '../../../testing/catalog';
import { provideFeatureTesting, request } from '../../../testing/http';
import { CatalogPage } from './catalog';

const catalog = (r: HttpRequest<unknown>) => r.url === '/api/v2/views/catalog';

describe('CatalogPage', () => {
  it('searches local and Open Food Facts foods, filters recipes and imports a hit', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(CatalogPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/recipes')).flush({
      recipes: [recipe(), { ...recipe({ id: 'recipe-2', name: 'Chili' }) }],
    });
    const search = element.querySelector<HTMLInputElement>('[name="q"]')!;
    search.value = 'sky';
    search.dispatchEvent(new Event('input'));
    const call = await request('/api/v2/views/catalog');
    expect(call.request.params.get('q')).toBe('sky');
    call.flush({
      local: [food()],
      remote: [
        {
          barcode: '999',
          name: 'Skyr Vanilla',
          brand: 'Siggi',
          per_100: { kcal: 80 },
          usable: true,
        },
      ],
      remote_error: null,
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('Skyr Vanilla');
    });
    expect(element.querySelector('a[href="/catalog/food/food-1"]')).not.toBeNull();
    expect(element.textContent).toContain('No recipe matches.');

    [...element.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Import')!
      .click();
    (await request('/api/v2/commands/import_food')).flush({
      result: food({ id: 'food-9' }),
      effects: { days: [] },
      warnings: [],
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/catalog/food', 'food-9']));
  });

  const boom = { status: 500, statusText: 'Server Error' };
  const found = (name: string) => ({
    local: [food({ id: `id-${name}`, name })],
    remote: [],
    remote_error: null,
  });

  async function open() {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(CatalogPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/recipes')).flush({ recipes: [] });
    const type = (text: string) => {
      const search = element.querySelector<HTMLInputElement>('[name="q"]')!;
      search.value = text;
      search.dispatchEvent(new Event('input'));
    };
    return { fixture, element, type };
  }

  it('shows a failed search as an alert without throwing', async () => {
    const { element, type } = await open();
    type('sky');
    (await request('/api/v2/views/catalog')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    });
  });

  it('shows a failed recipe list as an alert without throwing', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(CatalogPage);
    (await request('/api/v2/views/recipes')).flush({ title: 'Boom' }, boom);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
        'HTTP 500',
      );
    });
  });

  it('waits 250 ms after the last keystroke before searching', async () => {
    vi.useFakeTimers();
    try {
      const { type } = await open();
      const backend = TestBed.inject(HttpTestingController);
      type('sk');
      await vi.advanceTimersByTimeAsync(200);
      type('sky');
      await vi.advanceTimersByTimeAsync(200);
      TestBed.tick();
      expect(backend.match(catalog)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(50);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      const calls = backend.match(catalog);
      expect(calls).toHaveLength(1);
      expect(calls[0].request.params.get('q')).toBe('sky');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never searches after the page is destroyed', async () => {
    vi.useFakeTimers();
    try {
      const { fixture, type } = await open();
      const backend = TestBed.inject(HttpTestingController);
      type('sky');
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      fixture.destroy();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(backend.match(catalog)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newest results when an older response arrives late', async () => {
    const { fixture, element, type } = await open();
    type('sky');
    const older = await request('/api/v2/views/catalog');
    type('skyr');
    const newer = await request(
      (r) => r.url === '/api/v2/views/catalog' && r.params.get('q') === 'skyr',
    );
    newer.flush(found('Newer'));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('Newer');
    });
    older.flush(found('Older'));
    await fixture.whenStable();
    TestBed.tick();
    expect(element.textContent).toContain('Newer');
    expect(element.textContent).not.toContain('Older');
  });

  it('drops the results when the query falls below two characters', async () => {
    const { fixture, element, type } = await open();
    type('sky');
    (await request('/api/v2/views/catalog')).flush(found('Skyr'));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('Skyr');
    });
    type('s');
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).not.toContain('Skyr');
    });
  });

  describe('import', () => {
    const hit = {
      local: [],
      remote: [{ barcode: '999', name: 'Skyr Vanilla', brand: 'Siggi', per_100: {}, usable: true }],
      remote_error: null,
    };

    async function openWithHit() {
      const context = await open();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      context.type('sky');
      (await request('/api/v2/views/catalog')).flush(hit);
      await vi.waitFor(async () => {
        await context.fixture.whenStable();
        expect(context.element.textContent).toContain('Skyr Vanilla');
      });
      const importButton = () =>
        [...context.element.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Import',
        )!;
      const search = () => context.element.querySelector<HTMLInputElement>('[name="q"]')!;
      return { ...context, navigate, importButton, search };
    }

    it('names the search input and each import button', async () => {
      const { search, importButton } = await openWithHit();
      expect(search().getAttribute('aria-label')).toBe('Search foods and recipes');
      expect(importButton().getAttribute('aria-label')).toBe('Import Skyr Vanilla');
    });

    it.each([
      ['an existing food', food({ id: 'food-1', versions: 3 })],
      ['a restored food', food({ id: 'food-2', archived: false, versions: 4 })],
    ])('opens %s after the import', async (_name, result) => {
      const { navigate, importButton } = await openWithHit();
      importButton().click();
      (await request('/api/v2/commands/import_food')).flush({
        result,
        effects: { days: [] },
        warnings: [],
      });
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/catalog/food', result.id]));
    });

    it('clears a failed import when the query changes', async () => {
      const { fixture, element, type, importButton } = await openWithHit();
      importButton().click();
      (await request('/api/v2/commands/import_food')).flush({ title: 'Boom' }, boom);
      await vi.waitFor(() => {
        TestBed.tick();
        expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
      });
      type('skyr');
      (await request((r) => catalog(r) && r.params.get('q') === 'skyr')).flush(hit);
      await vi.waitFor(async () => {
        await fixture.whenStable();
        TestBed.tick();
        expect(element.querySelector('[role="alert"]')).toBeNull();
      });
    });

    it('sends one import while it is in flight and disables the button', async () => {
      const { fixture, importButton } = await openWithHit();
      importButton().click();
      importButton().click();
      const call = await request('/api/v2/commands/import_food');
      expect(call.request.body).toEqual({ barcode: '999', idempotency_key: expect.any(String) });
      TestBed.tick();
      expect(importButton().disabled).toBe(true);
      call.flush({ result: food(), effects: { days: [] }, warnings: [] });
      await fixture.whenStable();
    });

    it('shows a failed import inline and retries with the same key', async () => {
      const { element, importButton } = await openWithHit();
      importButton().click();
      const first = await request('/api/v2/commands/import_food');
      const key = (first.request.body as { idempotency_key: string }).idempotency_key;
      first.flush({ title: 'Boom' }, boom);
      await vi.waitFor(() => {
        TestBed.tick();
        expect(element.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
      });
      expect(element.querySelector('app-notices')).toBeNull();
      importButton().click();
      const second = await request('/api/v2/commands/import_food');
      expect((second.request.body as { idempotency_key: string }).idempotency_key).toBe(key);
    });
  });

  it('renders a food without brand or kcal without stray separators or "null"', async () => {
    const { fixture, element, type } = await open();
    type('sky');
    (await request('/api/v2/views/catalog')).flush({
      local: [
        food({ id: 'a', name: 'Plain', brand: null, per_100: { kcal: null } as never }),
        food({ id: 'b', name: 'Branded', brand: 'Arla', per_100: { kcal: 63 } }),
      ],
      remote: [
        { barcode: '1', name: 'Bare', brand: null, per_100: {}, usable: false },
        { barcode: '2', name: 'Fine', brand: 'Siggi', per_100: { kcal: 80 }, usable: true },
      ],
      remote_error: null,
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.textContent).toContain('Plain');
    });
    const row = (name: string) =>
      [...element.querySelectorAll('li')].find((li) => li.textContent?.includes(name))!;
    expect(row('Plain').textContent!.replace(/\s+/g, ' ').trim()).toBe('Plain');
    expect(row('Branded').textContent!.replace(/\s+/g, ' ').trim()).toBe(
      'Branded Arla · 63 kcal/100',
    );
    expect(row('Bare').querySelector('small')).toBeNull();
    expect(element.textContent).not.toContain('null');
    expect(row('Bare').querySelector('button')!.getAttribute('aria-label')).toBe(
      'No nutrients for Bare',
    );
  });
});
