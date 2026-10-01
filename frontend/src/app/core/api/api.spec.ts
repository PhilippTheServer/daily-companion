import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideTestConfig } from '../../../testing/config';
import { Api, reloadAfterCommands } from './api';
import { ApiError, errorText, toApiError } from './errors';

describe('Api', () => {
  let api: Api;
  let backend: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideTestConfig(), provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(Api);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('sends view parameters as a query and skips empty ones', async () => {
    const diary = api.view('diary', { days: 7, kinds: ['intake', 'symptom'], cursor: null });
    const call = backend.expectOne((r) => r.url === '/api/v2/views/diary');
    expect(call.request.urlWithParams).toBe(
      '/api/v2/views/diary?days=7&kinds=intake&kinds=symptom',
    );
    call.flush({ days: [], next_cursor: null });
    await expect(diary).resolves.toEqual({ days: [], next_cursor: null });
  });

  it('posts a command and bumps the revision', async () => {
    const done = api.command('retract_event', { id: 'e1', reason: 'typo' });
    const call = backend.expectOne('/api/v2/commands/retract_event');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ id: 'e1', reason: 'typo' });
    call.flush({ result: {}, effects: { days: ['2026-09-29'] }, warnings: [] });
    await done;
    expect(api.revision()).toBe(1);
  });

  it('turns an error body into an ApiError', async () => {
    const done = api.command('correct_event', { id: 'e1' });
    backend
      .expectOne('/api/v2/commands/correct_event')
      .flush(
        { code: 'stale_head', message: 'e1 is not the head', field: 'id' },
        { status: 409, statusText: 'Conflict' },
      );
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'stale_head', field: 'id', status: 409 });
    expect(api.revision()).toBe(0);
  });

  it('maps an error body without a field to field null', async () => {
    const done = api.view('diary');
    backend
      .expectOne('/api/v2/views/diary')
      .flush(
        { code: 'not_found', message: 'no such day' },
        { status: 404, statusText: 'Not Found' },
      );
    expect(await done.catch((e: unknown) => e)).toMatchObject({
      code: 'not_found',
      field: null,
      status: 404,
    });
  });

  it('maps a non-JSON error body to internal with the HTTP status', async () => {
    const done = api.view('diary');
    backend
      .expectOne('/api/v2/views/diary')
      .flush('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' });
    expect(await done.catch((e: unknown) => e)).toMatchObject({
      code: 'internal',
      message: 'The server answered HTTP 502.',
      field: null,
      status: 502,
    });
  });

  it('maps a network failure to offline', async () => {
    const done = api.view('diary');
    backend.expectOne('/api/v2/views/diary').error(new ProgressEvent('error'));
    expect(await done.catch((e: unknown) => e)).toMatchObject({
      code: 'offline',
      field: null,
      status: 0,
    });
  });

  it('maps a non-HTTP error to internal with status 0', () => {
    expect(toApiError(new TypeError('boom'))).toMatchObject({
      code: 'internal',
      message: 'boom',
      status: 0,
    });
    expect(toApiError('plain')).toMatchObject({ code: 'internal', message: 'plain', status: 0 });
  });

  it('reloads a view after each command, not before', () => {
    const view = { reload: vi.fn(() => true) };
    TestBed.runInInjectionContext(() => reloadAfterCommands(view));
    TestBed.tick();
    expect(view.reload).not.toHaveBeenCalled();
    api.revision.update((value) => value + 1);
    TestBed.tick();
    expect(view.reload).toHaveBeenCalledTimes(1);
  });

  it('loads the schemas once', async () => {
    const first = api.schemas();
    const second = api.schemas();
    backend.expectOne('/api/v2/schemas').flush({ commands: {}, queries: {}, payloads: {} });
    expect(await first).toBe(await second);
  });
});

describe('errorText', () => {
  it('prefixes the message with a title per code', () => {
    expect(errorText(new ApiError('validation', 'grams must be > 0', 'payload.grams', 422))).toBe(
      'Please check the input: grams must be > 0',
    );
    expect(errorText(new ApiError('offline', 'The server cannot be reached.', null, 0))).toBe(
      'Offline: The server cannot be reached.',
    );
    expect(errorText(new Error('boom'))).toBe('Something went wrong: boom');
  });

  it('falls back to the status for 401 and 403 when the code is unknown', () => {
    expect(errorText(new ApiError('weird', 'token expired', null, 401))).toBe(
      'Signed out: token expired',
    );
    expect(errorText(new ApiError('weird', 'nope', null, 403))).toBe(
      'This account may not use daily: nope',
    );
    expect(errorText(new ApiError('weird', 'odd', null, 500))).toBe('Something went wrong: odd');
  });
});
