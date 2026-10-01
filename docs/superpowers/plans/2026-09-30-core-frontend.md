# daily 2.0 Core frontend: implementation plan (plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Core frontend of daily 2.0 (spec
`docs/superpowers/specs/2026-09-29-daily2-core-design.md` §8): a mobile-first Angular PWA
with Today (the four gauges), the continuous Diary, Day, Event detail with history and
links, Catalog and Profile. Every create and edit form is generated from `GET /api/v2/schemas`.

**Architecture:** `frontend/` is one Angular application with standalone components,
signals and no zone.js. `core/` holds the typed API client, the single error-to-text
mapping, the runtime config, notices and a small own OIDC PKCE login. `shared/` holds the
three building blocks the screens share: `forms/` (a JSON-Schema form renderer with one
custom widget, the food picker, plus the event and command editors built on it),
`timeline/` (the time-stamped rows used by Today, Day and Diary) and `gauge/`.
`features/<screen>/` holds one folder per screen. Views are loaded with Angular's
`resource` and reload after every successful command. The container is nginx: it serves
the build, proxies `/api/` and `/health` to the backend and writes `assets/runtime-config.json`
from its environment at start, so one image runs locally and in the homelab.

**Tech Stack:** Angular 22 (standalone, signals, zoneless, `resource`, `@angular/service-worker`),
TypeScript 6, RxJS only where HttpClient needs it, Vitest with jsdom (Angular's default
unit-test runner), Prettier, openapi-typescript (run pinned through `npx`, not installed),
nginx 1.30, Node 24 LTS for the build.

**Plans:** 1 = Core backend (merged). 2 = Core frontend (this file). 3 = homelab deploy
(Ansible role `daily2`, Keycloak clients, the gym-bro export client).

## Decisions

Each decision keeps the dependency set at what `ng new` and `ng add @angular/pwa` create,
minus `@angular/forms`. Record these in the implementation issue.

| Question | Decision | Why |
|---|---|---|
| Login | Own PKCE code flow in `core/auth` (≈200 lines incl. interceptor and guard): S256 challenge, state check, code exchange, refresh 30 s before expiry, logout with `id_token_hint`. | One IdP, one flow, one client. `angular-auth-oidc-client` or `oidc-client-ts` add a config surface, silent-renew iframes and 30–60 kB for features daily does not use. The own code is unit-tested (incl. the RFC 7636 vector) and `e2e/ui_smoke.py` proves Keycloak accepts exactly this flow. |
| Token storage | `localStorage`, key `daily2.tokens`. | The PWA must survive an app restart without a login. The nginx CSP limits script sources to `'self'` and `connect-src` to `'self'` and Keycloak, which is the XSS mitigation. |
| API types | Generated from the backend's OpenAPI with `openapi-typescript@7.13.0`, run through `npx` by `scripts/snapshot-api.sh`; `core/api/types.ts` derives view and command types from `paths` so the client is typed end to end. | 80 schemas by hand would drift. The tool emits types only (no runtime code). It is not a devDependency because its `typescript@^5` peer conflicts with Angular 22's TypeScript 6. CI regenerates and fails on any diff. |
| Forms | Own renderer in `shared/forms` from JSON Schema (pydantic output: `$defs`/`$ref`, `anyOf` with `null`). Widgets: number, integer, string, text (maxLength ≥ 500), enum, boolean, date-time, date, object, array (of objects or scalars), multi-enum (array of enum), and the food picker for `food_id`/`recipe_id`. | Spec §8. No form library; `@angular/forms` is removed. |
| Test runner | Vitest + jsdom via `@angular/build:unit-test` (the `ng new` default in Angular 22), run in a Docker stage `docker build --target test frontend`. | Spec §11 says Karma; Karma is no longer the default and needs a browser. jsdom needs none, on the host or in CI. The spec is amended in Task 13. |
| Refresh after writes | `Api.revision` is bumped by every successful command; `reloadAfterCommands(resource)` reloads a view in place (its value stays on screen). The Diary restarts from the newest day. | One request per visible view; no client cache to keep consistent. `effects.days` is not needed for that. |
| Diary order | Newest day first; within a day, events in time order (the backend's shape); older days load when the "Load older days" button scrolls into view (IntersectionObserver) or is tapped. | "Continuous across days, older days as you scroll": the button is also the accessible fallback. |
| Runtime config | `assets/runtime-config.json` (`apiBase`, `keycloakUrl`, `realm`, `clientId`), fetched before bootstrap; the dev file lives in `public/assets/`, the container overwrites it at start from env. | One image for local and homelab. |
| Container contract | nginx on port 80, `GET /healthz` → 200, env `BACKEND_URL`, `API_BASE`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`. | Exactly what plan 3 (`2026-09-30-homelab-deploy.md`, "Frontend container contract") deploys. |
| CSP and critical CSS | Production builds set `inlineCritical: false`. | Angular's critical-CSS inlining adds an inline script that the CSP (`script-src` falls back to `'self'`) blocks, which would leave the full stylesheet unapplied. The stylesheet is 4 kB, so inlining gains nothing. `e2e/ui_smoke.py` fails if an inline script reappears. |
| Styling | One global `styles.css` with light/dark tokens plus small component styles; no UI kit. Gauges are meters (value, "x left of target" text, fill, over-target turns amber) so state never depends on colour alone. | Clean and calm on a phone, no dependency. |

## Global Constraints

- Angular: the latest stable major at implementation time (22.2.0 when this plan was
  written), created with `ng new`; TypeScript as the CLI pins it. Node 24 LTS in Docker.
- Runtime dependencies are exactly `@angular/common`, `@angular/compiler`, `@angular/core`,
  `@angular/platform-browser`, `@angular/router`, `@angular/service-worker`, `rxjs` and
  `tslib`. Dev dependencies are what `ng new` adds. A new dependency needs a justification
  in the issue first.
- Standalone components, signals and `input()`/`output()`/`model()`; no NgModules, no
  zone.js, no `@angular/forms`.
- `npm run lint` (`prettier --check .`) and `npm test` pass in `frontend/` at every commit.
  The code blocks below are already Prettier-formatted (printWidth 100, single quotes).
- No inline comments unless the *why* is non-obvious. Every exported class, function and
  constant gets a one-line `/** … */`.
- `core/api/errors.ts` (`errorText`) is the only place that turns an error into text.
- The UI does no nutrient maths or aggregation (spec §7.2). It only rounds for display and
  explains the targets the backend computed.
- Every timestamp the UI sends carries the browser's UTC offset (`fromLocalInput`).
  Timestamps are shown in the browser's time zone.
- Ports: dev server 4200, frontend container 18101, backend 18100, Keycloak 18180.
- The backend is not changed by this plan. Its contract enters the frontend only through
  `scripts/snapshot-api.sh`.
- Never write a secret into a tracked file.
- Before Task 0, open the implementation issue ("feat: Core frontend", linking this plan
  and copying the Decisions table). `<issue>` in every commit message below is that
  issue's number. Every commit message ends with `Refs #<issue>` and the line
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Run every command from `frontend/` unless a step says otherwise. A single spec runs
  with `npm test -- --include <path>`.
- Specs never `await fixture.whenStable()` while an HTTP request is open (the app is not
  stable until it ends); they use `request()`/`requests()` from `src/testing/http.ts`,
  which run change detection until the request exists.

## File map

```
frontend/
  package.json · package-lock.json · angular.json · tsconfig{,.app,.spec}.json
  .prettierrc · .prettierignore · .editorconfig · .gitignore · .dockerignore
  ngsw-config.json · proxy.conf.json · openapi.json (backend snapshot)
  Dockerfile · docker/default.conf.template · docker/40-runtime-config.sh
  scripts/snapshot-api.sh
  public/ assets/runtime-config.json · manifest.webmanifest · favicon.ico · icons/
  src/
    main.ts · index.html · styles.css
    app/
      app.ts · app.config.ts · app.routes.ts
      core/
        config.ts                RuntimeConfig, RUNTIME_CONFIG, loadRuntimeConfig
        notices.ts               Notices, NoticesView
        api/openapi.ts           generated
        api/types.ts             schema aliases; ViewName/ViewParams/ViewResult; CommandName/CommandInput/CommandResult
        api/errors.ts            ApiError, toApiError, errorText
        api/api.ts               Api (view, command, schemas, revision), reloadAfterCommands
        auth/pkce.ts             base64Url, randomString, challengeFor
        auth/auth.ts             Auth, REDIRECT, authInterceptor, authGuard
        auth/callback.ts         Callback (/callback)
      shared/
        time.ts                  localDay, toLocalInput, fromLocalInput, nowIso, clock, addDays, dayLabel, duration
        forms/schema.ts          JsonSchema, Field, Widget, Path, toField, formFor, initialValue, clean, updateIn, fieldUnder, labelFor, humanize
        forms/field-view.ts      FieldView (recursive), Edit
        forms/schema-form.ts     SchemaForm
        forms/food-picker.ts     FoodPicker
        forms/event-editor.ts    EventEditor, ENDS, editablePayload
        forms/command-form.ts    CommandForm
        gauge/gauge.ts           GaugeView
        timeline/describe.ts     describeEvent, kindLabel, KINDS, Line
        timeline/timeline.ts     Timeline
        timeline/day-summary.ts  DaySummaryView
        timeline/visible.ts      Visible
      features/
        today/today.ts           TodayPage
        day/day.ts               DayPage
        diary/diary.ts           DiaryPage
        event/event.ts · history.ts · link-row.ts · log.ts
        catalog/catalog.ts · food.ts · recipe.ts
        profile/profile.ts · derivation.ts
    testing/                     spec helpers, excluded from the app build
      config.ts · http.ts · schemas.ts · schemas.json · events.ts · views.ts · catalog.ts
docker-compose.yml (frontend service, profile ui) · keycloak/realm-dev.json (post-logout redirect)
e2e/ui_smoke.py · .github/workflows/ci.yml · README.md · spec §8/§11
```

---

### Task 0: Angular scaffold, PWA, API snapshot and generated types

**Files:**
- Create (generated, then edited): `frontend/` via `ng new` and `ng add @angular/pwa`
- Create: `frontend/proxy.conf.json`, `frontend/.prettierignore`, `frontend/public/assets/runtime-config.json`, `frontend/scripts/snapshot-api.sh`
- Generate: `frontend/openapi.json`, `frontend/src/testing/schemas.json`, `frontend/src/app/core/api/openapi.ts`
- Modify: `frontend/package.json`, `frontend/angular.json`, `frontend/tsconfig.app.json`, `frontend/tsconfig.spec.json`, `frontend/public/manifest.webmanifest`

**Interfaces:**
- Produces: an Angular 22 zoneless app named `daily2-frontend` (build output
  `dist/daily2-frontend/browser`), npm scripts `start`, `build`, `test`, `lint`, `api`;
  `src/testing/**` compiled for specs only; the generated `components`/`paths` types in
  `src/app/core/api/openapi.ts`; the schema snapshot `src/testing/schemas.json`.

- [ ] **Step 1: Generate the project**

From the repository root:

```bash
npm view @angular/cli version
npx -y @angular/cli@latest new daily2-frontend --directory frontend --routing --style css \
  --ssr=false --zoneless --test-runner vitest --ai-config none --skip-git --package-manager npm
cd frontend
npx ng add @angular/pwa --skip-confirmation
npm uninstall @angular/forms
rm -rf .vscode README.md
```

Expected: `ng new` ends with `Packages installed successfully.`, `ng add` creates
`ngsw-config.json`, `public/manifest.webmanifest` and `public/icons/*`, and updates
`angular.json`, `package.json`, `src/app/app.config.ts` and `src/index.html`.

- [ ] **Step 2: Adjust the generated configuration**

In `package.json`, delete the `"packageManager"` line (the Docker image's npm differs from
the host's) and replace `"scripts"` with:

```json
  "scripts": {
    "ng": "ng",
    "start": "ng serve",
    "build": "ng build",
    "test": "ng test --watch=false",
    "lint": "prettier --check .",
    "api": "scripts/snapshot-api.sh"
  },
```

The dependencies must now be exactly `@angular/common`, `@angular/compiler`,
`@angular/core`, `@angular/platform-browser`, `@angular/router`,
`@angular/service-worker`, `rxjs` and `tslib`.

In `angular.json`, give the `serve` target an `options` block (next to
`"defaultConfiguration": "development"`):

```json
          "options": {
            "proxyConfig": "proxy.conf.json"
          }
```

In `angular.json`, give the `production` build configuration (next to `"outputHashing"`)
an explicit optimization block that turns off critical-CSS inlining (it emits an inline
script, which the container's CSP blocks):

```json
              "optimization": {
                "scripts": true,
                "styles": { "minify": true, "inlineCritical": false },
                "fonts": true
              },
```

`tsconfig.app.json` becomes (spec helpers stay out of the app build):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": []
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.spec.ts", "src/testing/**"]
}
```

`tsconfig.spec.json` becomes:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*.d.ts", "src/**/*.spec.ts", "src/testing/**/*.ts"]
}
```

In `public/manifest.webmanifest`, set `"name": "daily"`, `"short_name": "daily"`,
`"start_url": "./today"`, and add `"background_color": "#f9f9f7"` and
`"theme_color": "#2a78d6"`. Keep the generated icons.

`proxy.conf.json` (the dev server forwards API calls, so the backend needs no CORS):

```json
{
  "/api": { "target": "http://localhost:18100", "secure": false },
  "/health": { "target": "http://localhost:18100", "secure": false }
}
```

`public/assets/runtime-config.json` (the dev values; the container overwrites this file):

```json
{
  "apiBase": "/api/v2",
  "keycloakUrl": "http://localhost:18180",
  "realm": "daily2",
  "clientId": "daily2-app"
}
```

`.prettierignore` (generated files):

```text
src/app/core/api/openapi.ts
src/testing/schemas.json
openapi.json
```

- [ ] **Step 3: The API snapshot script**

`scripts/snapshot-api.sh`:

```sh
#!/bin/sh
# Refreshes the backend contract the frontend is built against: openapi.json, the
# GET /api/v2/schemas snapshot the form tests use, and the generated TypeScript types.
set -eu
frontend="$(cd "$(dirname "$0")/.." && pwd)"
cd "$frontend/../backend"
uv run --frozen python - "$frontend" <<'PY'
import asyncio
import json
import sys
from pathlib import Path

from app.helpers.endpoints import schemas_api
from app.main import FEATURES, app

frontend = Path(sys.argv[1])
(frontend / "openapi.json").write_text(json.dumps(app.openapi(), indent=2) + "\n")
get_schemas = schemas_api(FEATURES).operations[0]
snapshot = asyncio.run(get_schemas.handler(None, None))
(frontend / "src/testing/schemas.json").write_text(
    json.dumps(snapshot.model_dump(mode="json"), indent=2) + "\n"
)
PY
cd "$frontend"
npx --yes openapi-typescript@7.13.0 openapi.json -o src/app/core/api/openapi.ts
```

```bash
chmod +x scripts/snapshot-api.sh
npm run api
```

Expected: the last lines are `✨ openapi-typescript 7.13.0` and
`🚀 openapi.json → src/app/core/api/openapi.ts`, and `openapi.json`,
`src/testing/schemas.json` and `src/app/core/api/openapi.ts` exist. The output is
deterministic, which CI relies on (Task 13) to catch a stale snapshot. When a newer
openapi-typescript exists (`npm view openapi-typescript version`), use it in the script
if it still generates `paths` and `components`.

- [ ] **Step 4: Format, test and build**

```bash
npx prettier --write .
npm run lint
npm test
npm run build
```

Expected: `All matched files use Prettier code style!`; the generated `app.spec.ts` gives
`Tests  2 passed (2)`; the build ends with `Application bundle generation complete.`

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "chore(frontend): scaffold the Angular PWA and snapshot the backend API

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---


### Task 1: Runtime config and the typed API client

**Files:**
- Create: `frontend/src/app/core/config.ts`, `frontend/src/app/core/api/types.ts`, `frontend/src/app/core/api/errors.ts`, `frontend/src/app/core/api/api.ts`
- Create: `frontend/src/testing/config.ts`, `frontend/src/testing/http.ts`
- Test: `frontend/src/app/core/config.spec.ts`, `frontend/src/app/core/api/api.spec.ts`

**Interfaces:**
- Consumes: `paths`, `components` from `core/api/openapi.ts` (Task 0).
- Produces:
  - `interface RuntimeConfig { apiBase; keycloakUrl; realm; clientId }` (all `string`),
    `RUNTIME_CONFIG: InjectionToken<RuntimeConfig>`,
    `loadRuntimeConfig(fetchFn?): Promise<RuntimeConfig>` (reads `assets/runtime-config.json`).
  - Types: `ContextOut, DayView, EnergyOut, DaySummary, Diary, DiaryDay, EventOut,
    EventHistory, ErrorBody, FoodOut, FoodSearchOut, Gauge, LinkOut, ProfileOut,
    ProfileView, RecipeOut, RecipeSummary, RemoteFood, SchemasOut, SyncStatusOut,
    TargetsOut, Kind, Relation`, and `ViewName`, `ViewParams<V>`, `ViewResult<V>`,
    `CommandName`, `CommandInput<C>`, `CommandResult<C>`.
  - `class ApiError extends Error { code: string; field: string | null; status: number }`,
    `toApiError(error: unknown): ApiError`, `errorText(error: unknown): string`.
  - `Api` (root service): `view(name, params?) → Promise<ViewResult>`,
    `command(name, body) → Promise<CommandResult>` (bumps `revision`),
    `schemas() → Promise<SchemasOut>` (cached), `revision: WritableSignal<number>`;
    `reloadAfterCommands(view: { reload(): boolean }): void` (injection context).
  - Spec helpers: `TEST_CONFIG`, `provideTestConfig()`; `provideFeatureTesting()`,
    `requests(match, count)`, `request(match)`.

- [ ] **Step 1: Write the failing tests**

`src/app/core/config.spec.ts`:

```ts
import { loadRuntimeConfig } from './config';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

const complete = {
  apiBase: '/api/v2',
  keycloakUrl: 'http://localhost:18180',
  realm: 'daily2',
  clientId: 'daily2-app',
};

describe('loadRuntimeConfig', () => {
  it('reads the four settings from assets/runtime-config.json', async () => {
    const fetchFn = vi.fn(fakeFetch(200, { ...complete, extra: 1 }));
    await expect(loadRuntimeConfig(fetchFn as typeof fetch)).resolves.toEqual(complete);
    expect(fetchFn).toHaveBeenCalledWith('assets/runtime-config.json', { cache: 'no-store' });
  });

  it('names missing settings', async () => {
    await expect(loadRuntimeConfig(fakeFetch(200, { apiBase: '/api/v2' }))).rejects.toThrow(
      'runtime-config.json is missing keycloakUrl, realm, clientId',
    );
  });

  it('fails on an HTTP error', async () => {
    await expect(loadRuntimeConfig(fakeFetch(404, {}))).rejects.toThrow(
      'runtime-config.json: HTTP 404',
    );
  });
});
```

`src/testing/config.ts`:

```ts
import { Provider } from '@angular/core';
import { RUNTIME_CONFIG, RuntimeConfig } from '../app/core/config';

export const TEST_CONFIG: RuntimeConfig = {
  apiBase: '/api/v2',
  keycloakUrl: 'http://kc.test',
  realm: 'daily2',
  clientId: 'daily2-app',
};

/** The runtime config every TestBed needs. */
export function provideTestConfig(): Provider {
  return { provide: RUNTIME_CONFIG, useValue: TEST_CONFIG };
}
```

`src/app/core/api/api.spec.ts`:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideTestConfig } from '../../../testing/config';
import { Api, reloadAfterCommands } from './api';
import { ApiError, errorText } from './errors';

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
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./config"` (and `"./api"`,
`"./errors"`).

- [ ] **Step 3: Implement**

`src/app/core/config.ts`:

```ts
import { InjectionToken } from '@angular/core';

/** Deployment settings read at startup from assets/runtime-config.json; one image runs anywhere. */
export interface RuntimeConfig {
  apiBase: string;
  keycloakUrl: string;
  realm: string;
  clientId: string;
}

export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG');

const KEYS: (keyof RuntimeConfig)[] = ['apiBase', 'keycloakUrl', 'realm', 'clientId'];

/** Fetch and check runtime-config.json; a missing or partial file stops the app loudly. */
export async function loadRuntimeConfig(fetchFn: typeof fetch = fetch): Promise<RuntimeConfig> {
  const response = await fetchFn('assets/runtime-config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`runtime-config.json: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as Record<string, unknown>;
  const missing = KEYS.filter((key) => typeof raw[key] !== 'string' || raw[key] === '');
  if (missing.length) {
    throw new Error(`runtime-config.json is missing ${missing.join(', ')}`);
  }
  return Object.fromEntries(KEYS.map((key) => [key, raw[key]])) as unknown as RuntimeConfig;
}
```

`src/app/core/api/types.ts`:

```ts
import type { components, paths } from './openapi';

type Schemas = components['schemas'];

export type ContextOut = Schemas['ContextOut'];
export type DayView = Schemas['DayView'];
export type EnergyOut = Schemas['EnergyOut'];
export type DaySummary = Schemas['DaySummary'];
export type Diary = Schemas['Diary'];
export type DiaryDay = Schemas['DiaryDay'];
export type EventOut = Schemas['EventOut'];
export type EventHistory = Schemas['EventHistory'];
export type ErrorBody = Schemas['ErrorBody'];
export type FoodOut = Schemas['FoodOut'];
export type FoodSearchOut = Schemas['FoodSearchOut'];
export type Gauge = Schemas['Gauge'];
export type LinkOut = Schemas['LinkOut'];
export type ProfileOut = Schemas['ProfileOut'];
export type ProfileView = Schemas['ProfileView'];
export type RecipeOut = Schemas['RecipeOut'];
export type RecipeSummary = Schemas['RecipeSummary'];
export type RemoteFood = Schemas['RemoteFood'];
export type SchemasOut = Schemas['SchemasOut'];
export type SyncStatusOut = Schemas['SyncStatusOut'];
export type TargetsOut = Schemas['TargetsOut'];
export type Kind = EventOut['kind'];
export type Relation = LinkOut['relation'];

type Route = keyof paths;
type Json<T> = T extends { content: { 'application/json': infer Body } } ? Body : never;

export type ViewName = Route extends infer R
  ? R extends `/api/v2/views/${infer V}`
    ? V
    : never
  : never;
export type CommandName = Route extends infer R
  ? R extends `/api/v2/commands/${infer C}`
    ? C
    : never
  : never;

export type ViewParams<V extends ViewName> = NonNullable<
  paths[`/api/v2/views/${V}`]['get']['parameters']['query']
>;
export type ViewResult<V extends ViewName> = Json<
  paths[`/api/v2/views/${V}`]['get']['responses'][200]
>;
export type CommandInput<C extends CommandName> = Json<
  NonNullable<paths[`/api/v2/commands/${C}`]['post']['requestBody']>
>;
export type CommandResult<C extends CommandName> = Json<
  paths[`/api/v2/commands/${C}`]['post']['responses'][200]
>;
```

`src/app/core/api/errors.ts`:

```ts
import { HttpErrorResponse } from '@angular/common/http';
import type { ErrorBody } from './types';

/** An API failure in the backend's {code, message, field} shape. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}

function isErrorBody(body: unknown): body is ErrorBody {
  const candidate = body as Partial<ErrorBody> | null;
  return typeof candidate?.code === 'string' && typeof candidate.message === 'string';
}

/** Any thrown value as an ApiError; the network being down is `offline`. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof HttpErrorResponse) {
    if (isErrorBody(error.error)) {
      return new ApiError(
        error.error.code,
        error.error.message,
        error.error.field ?? null,
        error.status,
      );
    }
    if (error.status === 0) {
      return new ApiError('offline', 'The server cannot be reached.', null, 0);
    }
    return new ApiError(
      'internal',
      `The server answered HTTP ${error.status}.`,
      null,
      error.status,
    );
  }
  return new ApiError('internal', error instanceof Error ? error.message : String(error), null, 0);
}

const TITLES: Record<string, string> = {
  validation: 'Please check the input',
  not_found: 'Not found',
  conflict: 'Conflict',
  stale_head: 'Changed in the meantime, reload to see the latest version',
  unauthorized: 'Signed out',
  forbidden: 'This account may not use daily',
  upstream: 'An outside service did not answer',
  internal: 'Something went wrong',
  offline: 'Offline',
};

/** The single place that turns an error into the sentence the user reads. */
export function errorText(error: unknown): string {
  const { code, message } = toApiError(error);
  return `${TITLES[code] ?? TITLES['internal']}: ${message}`;
}
```

`src/app/core/api/api.ts`:

```ts
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { RUNTIME_CONFIG } from '../config';
import { toApiError } from './errors';
import type {
  CommandInput,
  CommandName,
  CommandResult,
  SchemasOut,
  ViewName,
  ViewParams,
  ViewResult,
} from './types';

function queryParams(params: object | undefined): HttpParams {
  let result = new HttpParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && item !== undefined && item !== '') {
        result = result.append(key, String(item));
      }
    }
  }
  return result;
}

/** Typed access to /api/v2: views, commands and schemas. Every failure is an ApiError. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  private readonly base = inject(RUNTIME_CONFIG).apiBase;
  private schemaCache: Promise<SchemasOut> | null = null;

  /** Bumped after every successful command, so views that read it load again. */
  readonly revision = signal(0);

  view<V extends ViewName>(name: V, params?: ViewParams<V>): Promise<ViewResult<V>> {
    const url = `${this.base}/views/${name}`;
    return this.call(this.http.get<ViewResult<V>>(url, { params: queryParams(params) }));
  }

  async command<C extends CommandName>(name: C, body: CommandInput<C>): Promise<CommandResult<C>> {
    const url = `${this.base}/commands/${name}`;
    const result = await this.call(this.http.post<CommandResult<C>>(url, body));
    this.revision.update((value) => value + 1);
    return result;
  }

  /** The JSON Schemas of commands and payloads, loaded once per session. */
  schemas(): Promise<SchemasOut> {
    this.schemaCache ??= this.call(this.http.get<SchemasOut>(`${this.base}/schemas`)).catch(
      (error: unknown) => {
        this.schemaCache = null;
        throw error;
      },
    );
    return this.schemaCache;
  }

  private async call<T>(request: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request);
    } catch (error) {
      throw toApiError(error);
    }
  }
}

/**
 * Reload a view after every command while it stays on screen with its current value (a
 * changed resource parameter would blank it). Call in an injection context.
 */
export function reloadAfterCommands(view: { reload(): boolean }): void {
  const revision = inject(Api).revision;
  const initial = untracked(revision);
  effect(() => {
    if (revision() !== initial) {
      untracked(() => view.reload());
    }
  });
}
```

`src/testing/http.ts` (used by every feature spec from Task 5 on):

```ts
import { HttpRequest, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { EnvironmentProviders, Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTestConfig } from './config';

type Match = string | ((request: HttpRequest<unknown>) => boolean);

/** Config, router and a testing HttpClient: what every feature spec needs. */
export function provideFeatureTesting(): (Provider | EnvironmentProviders)[] {
  return [provideTestConfig(), provideRouter([]), provideHttpClient(), provideHttpClientTesting()];
}

/**
 * Run change detection until the app has sent `count` requests matching `match` (a URL path
 * or a predicate), then return them. Never await fixture.whenStable() while a request is
 * open: the app is not stable until it ends.
 */
export async function requests(match: Match, count: number): Promise<TestRequest[]> {
  const backend = TestBed.inject(HttpTestingController);
  const predicate =
    typeof match === 'string' ? (r: HttpRequest<unknown>) => r.url === match : match;
  return vi.waitFor(() => {
    TestBed.tick();
    const found = backend.match(predicate);
    if (found.length !== count) {
      throw new Error(`expected ${count} request(s), saw ${found.length}`);
    }
    return found;
  });
}

/** The one request matching `match`, once the app has sent it. */
export async function request(match: Match): Promise<TestRequest> {
  return (await requests(match, 1))[0];
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Test Files  3 passed (3)`, `Tests  11 passed (11)`.

A type check that the API types are live (optional, not committed): add
`const wrong: import('./types').ViewName = 'nope';` to `api.spec.ts`; `npm test` must fail
with `TS2322: Type '"nope"' is not assignable to type '"catalog" | "food" | …'`. Remove it.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): runtime config and the typed API client with one error mapping

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Login with OIDC PKCE

**Files:**
- Create: `frontend/src/app/core/auth/pkce.ts`, `frontend/src/app/core/auth/auth.ts`, `frontend/src/app/core/auth/callback.ts`
- Modify: `keycloak/realm-dev.json` (client `daily2-app`)
- Test: `frontend/src/app/core/auth/pkce.spec.ts`, `frontend/src/app/core/auth/auth.spec.ts`, `frontend/src/app/core/auth/callback.spec.ts`

**Interfaces:**
- Consumes: `RUNTIME_CONFIG` (Task 1).
- Produces: `base64Url(bytes)`, `randomString(bytes = 32)`, `challengeFor(verifier)`;
  `REDIRECT: InjectionToken<(url: string) => void>`; `Auth` (root service) with
  `signedIn: Signal<boolean>`, `login(returnTo: string): Promise<void>`,
  `completeLogin(params: URLSearchParams): Promise<string>` (returns `returnTo`),
  `accessToken(): Promise<string | null>`, `logout(): void`; `authInterceptor`
  (HttpInterceptorFn, only for URLs under `apiBase`, 401 → `login(router.url)`);
  `authGuard` (CanActivateFn); `Callback` component for `/callback`.
- Keycloak endpoints used: `{keycloakUrl}/realms/{realm}/protocol/openid-connect/{auth,token,logout}`;
  redirect URI `{origin}/callback`; post-logout redirect `{origin}/`.

- [ ] **Step 1: Write the failing tests**

`src/app/core/auth/pkce.spec.ts` (the challenge is RFC 7636 appendix B):

```ts
import { base64Url, challengeFor, randomString } from './pkce';

describe('pkce', () => {
  it('encodes base64url without padding', () => {
    expect(base64Url(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(base64Url(new Uint8Array([1]))).toBe('AQ');
  });

  it('makes a 43-character verifier from 32 bytes', () => {
    const verifier = randomString();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomString()).not.toBe(verifier);
  });

  it('computes the RFC 7636 appendix B challenge', async () => {
    await expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
```

`src/app/core/auth/auth.spec.ts`:

```ts
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { provideTestConfig } from '../../../testing/config';
import { Auth, REDIRECT, authInterceptor } from './auth';

function tokenResponse(expiresIn = 300, access = 'access-1') {
  return new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: 'refresh-1',
      id_token: 'id-1',
      expires_in: expiresIn,
    }),
    { status: 200 },
  );
}

describe('Auth', () => {
  let redirect: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    redirect = vi.fn();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    TestBed.configureTestingModule({
      providers: [
        provideTestConfig(),
        { provide: REDIRECT, useValue: redirect },
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => fetchSpy.mockRestore());

  async function signIn(expiresIn = 300): Promise<Auth> {
    const auth = TestBed.inject(Auth);
    await auth.login('/diary');
    const url = new URL(redirect.mock.calls[0][0] as string);
    fetchSpy.mockResolvedValueOnce(tokenResponse(expiresIn));
    const returnTo = await auth.completeLogin(
      new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state')! }),
    );
    expect(returnTo).toBe('/diary');
    return auth;
  }

  it('redirects to Keycloak with an S256 challenge', async () => {
    await TestBed.inject(Auth).login('/today');
    const url = new URL(redirect.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(
      'http://kc.test/realms/daily2/protocol/openid-connect/auth',
    );
    expect(url.searchParams.get('client_id')).toBe('daily2-app');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/callback`);
  });

  it('exchanges the code with the verifier and stores the tokens', async () => {
    const auth = await signIn();
    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('http://kc.test/realms/daily2/protocol/openid-connect/token');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.signedIn()).toBe(true);
    await expect(auth.accessToken()).resolves.toBe('access-1');
  });

  it('rejects a callback whose state does not match', async () => {
    const auth = TestBed.inject(Auth);
    await auth.login('/today');
    await expect(
      auth.completeLogin(new URLSearchParams({ code: 'c', state: 'forged' })),
    ).rejects.toThrow('could not be verified');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes a token that is about to expire', async () => {
    const auth = await signIn(10);
    fetchSpy.mockResolvedValueOnce(tokenResponse(300, 'access-2'));
    await expect(auth.accessToken()).resolves.toBe('access-2');
    const body = (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('signs out when the refresh fails', async () => {
    const auth = await signIn(10);
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(auth.accessToken()).resolves.toBeNull();
    expect(auth.signedIn()).toBe(false);
  });

  it('adds the bearer token to API calls only, and logs in again on 401', async () => {
    await signIn();
    const http = TestBed.inject(HttpClient);
    const backend = TestBed.inject(HttpTestingController);
    const api = firstValueFrom(http.get('/api/v2/views/today'));
    await Promise.resolve();
    const call = backend.expectOne('/api/v2/views/today');
    expect(call.request.headers.get('Authorization')).toBe('Bearer access-1');
    call.flush({ code: 'unauthorized', message: 'expired' }, { status: 401, statusText: 'x' });
    await expect(api).rejects.toBeTruthy();
    await vi.waitFor(() => expect(redirect).toHaveBeenCalledTimes(2));

    const other = firstValueFrom(http.get('/runtime-config.json'));
    backend.expectOne('/runtime-config.json').flush({});
    await other;
    backend.verify();
  });
});
```

`src/app/core/auth/callback.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Auth } from './auth';
import { Callback } from './callback';

describe('Callback', () => {
  it('finishes the login and goes where the user wanted to go', async () => {
    const auth = { completeLogin: vi.fn().mockResolvedValue('/diary'), login: vi.fn() };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: Auth, useValue: auth }],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(Callback);
    await fixture.whenStable();
    expect(auth.completeLogin).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/diary', { replaceUrl: true });
  });

  it('shows why the login failed and offers to sign in again', async () => {
    const auth = {
      completeLogin: vi.fn().mockRejectedValue(new Error('state mismatch')),
      login: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: Auth, useValue: auth }],
    });
    const fixture = TestBed.createComponent(Callback);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.form-error')!.textContent).toBe('state mismatch');
    element.querySelector('button')!.click();
    expect(auth.login).toHaveBeenCalledWith('/today');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./pkce"` (and `"./auth"`, `"./callback"`).

- [ ] **Step 3: Implement**

`src/app/core/auth/pkce.ts`:

```ts
/** URL-safe base64 without padding, as PKCE and OAuth state need. */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** A random, URL-safe string from `bytes` bytes of entropy. */
export function randomString(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 code challenge of a PKCE verifier (RFC 7636). */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
```

`src/app/core/auth/auth.ts`:

```ts
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { from, switchMap, tap } from 'rxjs';
import { RUNTIME_CONFIG } from '../config';
import { challengeFor, randomString } from './pkce';

/** Leaves the app for Keycloak; replaced in tests. */
export const REDIRECT = new InjectionToken<(url: string) => void>('REDIRECT', {
  factory: () => (url: string) => window.location.assign(url),
});

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
}

interface PendingLogin {
  verifier: string;
  state: string;
  returnTo: string;
}

const TOKENS = 'daily2.tokens';
const PENDING = 'daily2.login';
const REFRESH_MARGIN_MS = 30_000;

function read<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** OIDC authorization code flow with PKCE against Keycloak, with silent refresh. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly config = inject(RUNTIME_CONFIG);
  private readonly redirect = inject(REDIRECT);
  private readonly tokens = signal<Tokens | null>(read<Tokens>(localStorage, TOKENS));
  private refreshing: Promise<string | null> | null = null;

  readonly signedIn = computed(() => this.tokens() !== null);

  /** Start a login; the browser comes back to /callback. */
  async login(returnTo: string): Promise<void> {
    const pending: PendingLogin = { verifier: randomString(), state: randomString(16), returnTo };
    sessionStorage.setItem(PENDING, JSON.stringify(pending));
    const url = new URL(this.endpoint('auth'));
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      scope: 'openid',
      redirect_uri: this.callbackUrl(),
      state: pending.state,
      code_challenge: await challengeFor(pending.verifier),
      code_challenge_method: 'S256',
    }).toString();
    this.redirect(url.toString());
  }

  /** Finish a login from the callback's query; returns where the user wanted to go. */
  async completeLogin(params: URLSearchParams): Promise<string> {
    const pending = read<PendingLogin>(sessionStorage, PENDING);
    sessionStorage.removeItem(PENDING);
    const error = params.get('error');
    if (error) {
      throw new Error(params.get('error_description') ?? error);
    }
    const code = params.get('code');
    if (!pending || !code || params.get('state') !== pending.state) {
      throw new Error('The sign-in could not be verified. Please sign in again.');
    }
    await this.exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl(),
      code_verifier: pending.verifier,
    });
    return pending.returnTo;
  }

  /** A valid access token, refreshed when it is about to expire; null when signed out. */
  async accessToken(): Promise<string | null> {
    const tokens = this.tokens();
    if (!tokens) {
      return null;
    }
    if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      this.clear();
      return null;
    }
    this.refreshing ??= this.exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    })
      .then(
        () => this.tokens()?.accessToken ?? null,
        () => {
          this.clear();
          return null;
        },
      )
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Forget the tokens and end the Keycloak session. */
  logout(): void {
    const idToken = this.tokens()?.idToken;
    this.clear();
    const url = new URL(this.endpoint('logout'));
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      post_logout_redirect_uri: `${window.location.origin}/`,
      ...(idToken ? { id_token_hint: idToken } : {}),
    }).toString();
    this.redirect(url.toString());
  }

  private endpoint(name: 'auth' | 'token' | 'logout'): string {
    const { keycloakUrl, realm } = this.config;
    return `${keycloakUrl}/realms/${realm}/protocol/openid-connect/${name}`;
  }

  private callbackUrl(): string {
    return `${window.location.origin}/callback`;
  }

  private async exchange(body: Record<string, string>): Promise<void> {
    const response = await fetch(this.endpoint('token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, ...body }),
    });
    if (!response.ok) {
      throw new Error(`Keycloak refused the sign-in (HTTP ${response.status}).`);
    }
    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in: number;
    };
    const tokens: Tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      idToken: data.id_token ?? null,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    localStorage.setItem(TOKENS, JSON.stringify(tokens));
    this.tokens.set(tokens);
  }

  private clear(): void {
    localStorage.removeItem(TOKENS);
    this.tokens.set(null);
  }
}

/** Adds the bearer token to API requests; a 401 starts a new login. */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(Auth);
  const router = inject(Router);
  if (!request.url.startsWith(inject(RUNTIME_CONFIG).apiBase)) {
    return next(request);
  }
  return from(auth.accessToken()).pipe(
    switchMap((token) =>
      next(token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request),
    ),
    tap({
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse && error.status === 401) {
          void auth.login(router.url);
        }
      },
    }),
  );
};

/** Lets a route open only when signed in; otherwise starts the login. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  if (await auth.accessToken()) {
    return true;
  }
  await auth.login(state.url);
  return false;
};
```

`src/app/core/auth/callback.ts`:

```ts
import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Auth } from './auth';

/** /callback: Keycloak sends the browser here with the code; finish the login and move on. */
@Component({
  selector: 'app-callback',
  template: `
    @if (error(); as message) {
      <p class="form-error">{{ message }}</p>
      <button type="button" (click)="retry()">Sign in again</button>
    } @else {
      <p class="muted">Signing in…</p>
    }
  `,
})
export class Callback implements OnInit {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);

  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const returnTo = await this.auth.completeLogin(new URLSearchParams(window.location.search));
      await this.router.navigateByUrl(returnTo, { replaceUrl: true });
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected retry(): void {
    void this.auth.login('/today');
  }
}
```

In `keycloak/realm-dev.json`, give the `daily2-app` client a post-logout redirect (`+`
means "the redirect URIs"), so `Auth.logout()` returns to the app:

```json
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "+"
      }
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  22 passed (22)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend keycloak/realm-dev.json
git commit -m "feat(frontend): OIDC login with PKCE, token refresh, API interceptor and guard

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: App shell, time helpers and notices

**Files:**
- Create: `frontend/src/app/shared/time.ts`, `frontend/src/app/core/notices.ts`
- Replace: `frontend/src/app/app.ts`, `frontend/src/app/app.config.ts`, `frontend/src/app/app.routes.ts`, `frontend/src/main.ts`, `frontend/src/index.html`, `frontend/src/styles.css`
- Delete: `frontend/src/app/app.html`, `frontend/src/app/app.css`
- Test: `frontend/src/app/shared/time.spec.ts`, `frontend/src/app/core/notices.spec.ts`, `frontend/src/app/app.spec.ts` (replace)

**Interfaces:**
- Consumes: `RUNTIME_CONFIG`, `loadRuntimeConfig`, `errorText` (Task 1); `authInterceptor`,
  `authGuard`, `Callback` (Task 2).
- Produces:
  - `localDay(date?) → 'YYYY-MM-DD'`, `toLocalInput(iso) → 'YYYY-MM-DDTHH:mm'`,
    `fromLocalInput(local) → ISO with offset`, `nowIso()`, `clock(iso) → 'HH:mm'`,
    `addDays(day, n)`, `dayLabel(day, today?) → 'Today' | 'Yesterday' | 'Mon 21 Sep'`,
    `duration(from, to) → '7 h 20 min'`.
  - `Notices` (root): `items: Signal<Notice[]>`, `show(text, tone?)`, `error(error)`,
    `warnings(warnings = [])`, `dismiss(id)`; `NoticesView` (`<app-notices>`).
  - `appConfig(config: RuntimeConfig): ApplicationConfig` with router
    (`withComponentInputBinding`, so route params arrive as component inputs), HttpClient
    (`withFetch`, `authInterceptor`) and the service worker.
  - `routes`: `/callback` outside the guard; a guarded parent whose `children` later tasks
    extend, always inserting **before** the final `{ path: '**', redirectTo: 'today' }`.
  - Global CSS tokens: `--page --surface --ink --ink-2 --line --accent --track --warning
    --critical` and the classes `.page-head .muted .actions .kind-picker .chips .warnings
    .label .hint .invalid .field-error .form-error .array-item .list .choices .candidates
    .history .derivation .rows .items .num .retracted-note .chosen .signout`, and button
    variants `.secondary .danger .link .add`.

- [ ] **Step 1: Write the failing tests**

`src/app/shared/time.spec.ts`:

```ts
import { addDays, dayLabel, duration, fromLocalInput, localDay, toLocalInput } from './time';

describe('time', () => {
  it('writes a local input as ISO with an offset for the same instant', () => {
    const iso = fromLocalInput('2026-09-29T08:15');
    expect(iso).toMatch(/^2026-09-29T08:15:00[+-]\d\d:\d\d$/);
    expect(new Date(iso).getTime()).toBe(new Date('2026-09-29T08:15').getTime());
    expect(toLocalInput(iso)).toBe('2026-09-29T08:15');
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('labels today, yesterday and older days', () => {
    expect(dayLabel('2026-09-29', '2026-09-29')).toBe('Today');
    expect(dayLabel('2026-09-28', '2026-09-29')).toBe('Yesterday');
    expect(dayLabel('2026-09-21', '2026-09-29')).toBe('Mon 21 Sep');
  });

  it('formats durations', () => {
    expect(duration('2026-09-28T22:40:00Z', '2026-09-29T06:00:00Z')).toBe('7 h 20 min');
    expect(duration('2026-09-29T10:00:00Z', '2026-09-29T10:45:00Z')).toBe('45 min');
  });

  it('formats a local day', () => {
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
```

`src/app/core/notices.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { ApiError } from './api/errors';
import { Notices } from './notices';

describe('Notices', () => {
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
    vi.useRealTimers();
  });
});
```

Replace `src/app/app.spec.ts` with:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  it('shows the four main tabs', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const tabs = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.tabs a')];
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual([
      '/today',
      '/diary',
      '/catalog',
      '/profile',
    ]);
  });

  it('keeps /callback outside the login guard', () => {
    expect(routes[0]).toMatchObject({ path: 'callback' });
    expect(routes[1].canActivateChild).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./time"` and `"./notices"`.

- [ ] **Step 3: Implement**

`src/app/shared/time.ts`:

```ts
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

/** A date as YYYY-MM-DD in the browser's time zone. */
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** An ISO timestamp as the value of an <input type="datetime-local">. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  return `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local value as ISO 8601 with the browser's UTC offset, as the API requires. */
export function fromLocalInput(local: string): string {
  const offset = -new Date(local).getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const minutes = Math.abs(offset);
  return `${local}:00${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Now, to the minute, with the UTC offset. */
export function nowIso(): string {
  return fromLocalInput(toLocalInput(new Date().toISOString()));
}

/** HH:mm of an ISO timestamp in the browser's time zone. */
export function clock(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The day `days` after a YYYY-MM-DD day (negative for before). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

/** "Today", "Yesterday" or a short weekday date such as "Mon 28 Sep". */
export function dayLabel(day: string, today = localDay()): string {
  if (day === today) {
    return 'Today';
  }
  if (day === addDays(today, -1)) {
    return 'Yesterday';
  }
  const date = new Date(`${day}T12:00:00`);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** A duration between two ISO timestamps as "7 h 20 min". */
export function duration(from: string, to: string): string {
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
```

`src/app/core/notices.ts`:

```ts
import { Component, Injectable, inject, signal } from '@angular/core';
import { errorText } from './api/errors';

export interface Notice {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const VISIBLE_MS = { info: 4000, error: 8000 };

/** Short messages at the bottom of the screen: command warnings and errors outside forms. */
@Injectable({ providedIn: 'root' })
export class Notices {
  private next = 0;
  readonly items = signal<Notice[]>([]);

  show(text: string, tone: Notice['tone'] = 'info'): void {
    const id = ++this.next;
    this.items.update((items) => [...items, { id, text, tone }]);
    setTimeout(() => this.dismiss(id), VISIBLE_MS[tone]);
  }

  error(error: unknown): void {
    this.show(errorText(error), 'error');
  }

  /** Show the warnings a command answered with. */
  warnings(warnings: string[] = []): void {
    for (const warning of warnings) {
      this.show(warning);
    }
  }

  dismiss(id: number): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }
}

/** Renders the notices; placed once in the shell. */
@Component({
  selector: 'app-notices',
  template: `
    <div class="notices" aria-live="polite">
      @for (notice of notices.items(); track notice.id) {
        <button type="button" [class]="notice.tone" (click)="notices.dismiss(notice.id)">
          {{ notice.text }}
        </button>
      }
    </div>
  `,
  styles: `
    .notices {
      position: fixed;
      inset: auto 1rem 4.5rem 1rem;
      display: grid;
      gap: 0.5rem;
      max-width: 38rem;
      margin: 0 auto;
      z-index: 10;
    }
    button {
      text-align: left;
      padding: 0.75rem 1rem;
      border-radius: 0.75rem;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink);
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.12);
    }
    .error {
      border-color: var(--critical);
    }
  `,
})
export class NoticesView {
  protected readonly notices = inject(Notices);
}
```

`src/app/app.ts` (delete `app.html` and `app.css`):

```ts
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NoticesView } from './core/notices';

/** The shell: the current screen above a bottom navigation bar. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NoticesView],
  template: `
    <main><router-outlet /></main>
    <app-notices />
    <nav class="tabs" aria-label="Main">
      <a routerLink="/today" routerLinkActive="active">Today</a>
      <a routerLink="/diary" routerLinkActive="active">Diary</a>
      <a routerLink="/catalog" routerLinkActive="active">Catalog</a>
      <a routerLink="/profile" routerLinkActive="active">Profile</a>
    </nav>
  `,
  styles: `
    main {
      max-width: 40rem;
      margin: 0 auto;
      padding: 1rem 1rem 5rem;
    }
    .tabs {
      position: fixed;
      inset: auto 0 0 0;
      display: flex;
      justify-content: space-around;
      padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom));
      background: var(--surface);
      border-top: 1px solid var(--line);
    }
    .tabs a {
      color: var(--ink-2);
      text-decoration: none;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
    }
    .tabs a.active {
      color: var(--accent);
      font-weight: 600;
    }
  `,
})
export class App {}
```

`src/app/app.config.ts`:

```ts
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth';
import { RUNTIME_CONFIG, RuntimeConfig } from './core/config';

/** Providers for the app, given the runtime config loaded before bootstrap. */
export function appConfig(config: RuntimeConfig): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      { provide: RUNTIME_CONFIG, useValue: config },
      provideRouter(routes, withComponentInputBinding()),
      provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
      provideServiceWorker('ngsw-worker.js', {
        enabled: !isDevMode(),
        registrationStrategy: 'registerWhenStable:30000',
      }),
    ],
  };
}
```

`src/app/app.routes.ts` (the screens are added by Tasks 8–12; until then `today` does
not exist, so do not open the app in a browser before Task 8):

```ts
import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth';
import { Callback } from './core/auth/callback';

export const routes: Routes = [
  { path: 'callback', component: Callback },
  {
    path: '',
    canActivateChild: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'today' },
      { path: '**', redirectTo: 'today' },
    ],
  },
];
```

`src/main.ts` (the config is loaded before Angular starts; a broken config is shown, not
swallowed):

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { loadRuntimeConfig } from './app/core/config';

loadRuntimeConfig()
  .then((config) => bootstrapApplication(App, appConfig(config)))
  .catch((error: unknown) => {
    document.body.textContent = `daily could not start: ${error instanceof Error ? error.message : error}`;
  });
```

`src/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>daily</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#f9f9f7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0d0d0d" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/x-icon" href="favicon.ico" />
    <link rel="manifest" href="manifest.webmanifest" />
    <link rel="apple-touch-icon" href="icons/icon-192x192.png" />
  </head>
  <body>
    <app-root></app-root>
    <noscript>daily needs JavaScript.</noscript>
  </body>
</html>
```

`src/styles.css` (light and dark tokens; the gauge colours follow the dataviz reference
palette: accent `#2a78d6`/`#3987e5`, a lighter track of the same hue, amber `#fab219`
for "over"):

```css
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --line: #e1e0d9;
  --accent: #2a78d6;
  --track: #dce8f7;
  --warning: #fab219;
  --critical: #d03b3b;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --line: #2c2c2a;
    --accent: #3987e5;
    --track: #1f3350;
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --line: #2c2c2a;
  --accent: #3987e5;
  --track: #1f3350;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font:
    16px/1.45 system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;
  -webkit-text-size-adjust: 100%;
}

h1 {
  font-size: 1.5rem;
  margin: 0.5rem 0;
}

h2 {
  font-size: 1rem;
  margin: 1.5rem 0 0.5rem;
  color: var(--ink-2);
}

a {
  color: var(--accent);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.page-head a {
  font-size: 1.5rem;
  text-decoration: none;
  padding: 0 0.75rem;
}

.muted {
  color: var(--ink-2);
}

button,
.button {
  font: inherit;
  padding: 0.6rem 1rem;
  border-radius: 0.6rem;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  cursor: pointer;
}

button.secondary,
.button.secondary {
  background: transparent;
  color: var(--accent);
}

button.danger {
  background: transparent;
  border-color: var(--critical);
  color: var(--critical);
}

button.link {
  background: none;
  border: none;
  color: var(--accent);
  padding: 0.25rem 0.5rem;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

button.add {
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  padding: 0;
  font-size: 1.5rem;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1rem 0;
}

.kind-picker,
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0.5rem 0 1rem;
}

.kind-picker a,
.chips button {
  padding: 0.4rem 0.8rem;
  border-radius: 1rem;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
  font-size: 0.875rem;
}

.chips button.on {
  border-color: var(--accent);
  color: var(--accent);
}

.warnings {
  padding: 0.5rem 0.75rem 0.5rem 2rem;
  border-left: 3px solid var(--warning);
  background: var(--surface);
}

form,
fieldset {
  display: grid;
  gap: 0.75rem;
}

fieldset {
  border: 1px solid var(--line);
  border-radius: 0.6rem;
  padding: 0.75rem;
  margin: 0;
}

label {
  display: grid;
  gap: 0.25rem;
}

label.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.label {
  font-size: 0.875rem;
  color: var(--ink-2);
}

input,
select,
textarea {
  font: inherit;
  width: 100%;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  background: var(--surface);
  color: var(--ink);
}

input[type='checkbox'] {
  width: auto;
}

.hint {
  color: var(--ink-2);
  font-size: 0.8rem;
}

.invalid input,
.invalid select,
.invalid textarea,
fieldset.invalid {
  border-color: var(--critical);
}

.field-error,
.form-error {
  color: var(--critical);
  font-size: 0.875rem;
  margin: 0.25rem 0;
}

.array-item {
  display: grid;
  gap: 0.25rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px dashed var(--line);
}

.list,
.choices,
.candidates,
.history,
.derivation {
  list-style: none;
  padding: 0;
  margin: 0;
}

.list li,
.choices li,
.candidates li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--line);
}

.choices button,
.candidates button {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--ink);
  padding: 0.25rem 0;
}

.history li,
.derivation li {
  padding: 0.3rem 0;
  color: var(--ink-2);
  font-size: 0.9rem;
}

.rows {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.3rem 1rem;
}

.rows dt {
  color: var(--ink-2);
}

.rows dd {
  margin: 0;
}

.items {
  width: 100%;
  border-collapse: collapse;
}

.items td {
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--line);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.retracted-note {
  color: var(--critical);
}

.chosen {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

app-link-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
  padding: 0.3rem 0;
}

.signout {
  margin-top: 2rem;
}
```

- [ ] **Step 4: Run the tests and the build**

Run: `npm run lint && npm test && npm run build`
Expected: `Tests  28 passed (28)`; `Application bundle generation complete.`

- [ ] **Step 5: Commit**

```bash
cd .. && git add -A frontend
git commit -m "feat(frontend): app shell with tabs, notices, time helpers and runtime-config bootstrap

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---


### Task 4: The schema model of the form renderer

**Files:**
- Create: `frontend/src/app/shared/forms/schema.ts`, `frontend/src/testing/schemas.ts`
- Test: `frontend/src/app/shared/forms/schema.spec.ts`

**Interfaces:**
- Consumes: `SchemasOut` (Task 1); the snapshot `src/testing/schemas.json` (Task 0).
- Produces (all pure):
  - `interface JsonSchema` (the pydantic subset: `type format enum properties required
    items anyOf $ref $defs description default minimum maximum exclusiveMinimum
    exclusiveMaximum maxLength pattern maxItems`).
  - `type Widget = 'number' | 'integer' | 'string' | 'text' | 'enum' | 'boolean' |
    'date-time' | 'date' | 'object' | 'array' | 'multi-enum' | 'food-picker'`.
  - `interface Field { key; label; hint; widget; required; nullable; options; min; max;
    maxLength; pattern; maxItems; initial; fields: Field[]; item: Field | null;
    pick: 'food' | 'recipe' | null }`.
  - `toField(schema, root?, key?, required?)`, `formFor(schema, omit = []) → Field`
    (always drops `idempotency_key`), `initialValue(field)`, `clean(field, value)` (keeps
    only schema keys; empty optional → `null` when nullable, else left out; empty required →
    left out), `type Path = (string | number)[]`, `updateIn(root, path, change)`,
    `fieldUnder(path, prefix)`, `labelFor(key)` ("goal_weight_kg" → "Goal weight (kg)",
    "food_id" → "Food"),
    `humanize(value)` ("stomach_ache" → "Stomach ache").
  - Spec helpers: `SCHEMAS`, `payloadSchema(kind)`, `commandSchema(name)`.

- [ ] **Step 1: Write the failing test**

`src/testing/schemas.ts`:

```ts
import type { SchemasOut } from '../app/core/api/types';
import type { JsonSchema } from '../app/shared/forms/schema';
import snapshot from './schemas.json';

/** GET /api/v2/schemas as the backend answered when the snapshot was taken. */
export const SCHEMAS = snapshot as unknown as SchemasOut;

export function payloadSchema(kind: string): JsonSchema {
  return SCHEMAS.payloads[kind] as JsonSchema;
}

export function commandSchema(name: string): JsonSchema {
  return SCHEMAS.commands[name] as JsonSchema;
}
```

`src/app/shared/forms/schema.spec.ts` (every payload kind of the real snapshot must build):

```ts
import { SCHEMAS, commandSchema, payloadSchema } from '../../../testing/schemas';
import { Field, clean, fieldUnder, formFor, initialValue, labelFor, updateIn } from './schema';

function child(field: Field, key: string): Field {
  const found = field.fields.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no field ${key}`);
  }
  return found;
}

describe('formFor', () => {
  it.each(Object.keys(SCHEMAS.payloads))('builds a form for the %s payload', (kind) => {
    const form = formFor(payloadSchema(kind));
    expect(form.widget).toBe('object');
    expect(form.fields.length).toBeGreaterThan(0);
  });

  it.each(['update_profile', 'set_source_preference', 'save_food', 'save_recipe', 'import_food'])(
    'builds a form for the %s command without the idempotency key',
    (name) => {
      const form = formFor(commandSchema(name), ['id']);
      expect(form.fields.map((field) => field.key)).not.toContain('idempotency_key');
      expect(form.fields.map((field) => field.key)).not.toContain('id');
    },
  );

  it('maps the intake payload to pickers, an item list and a text note', () => {
    const intake = formFor(payloadSchema('intake'));
    expect(child(intake, 'slot')).toMatchObject({
      widget: 'enum',
      nullable: true,
      options: ['breakfast', 'lunch', 'dinner', 'snack'],
    });
    const items = child(intake, 'items');
    expect(items.widget).toBe('array');
    expect(items.maxItems).toBe(60);
    expect(child(items.item!, 'food_id')).toMatchObject({ widget: 'food-picker', pick: 'food' });
    expect(child(items.item!, 'grams')).toMatchObject({
      widget: 'number',
      required: true,
      max: 5000,
    });
    expect(child(intake, 'recipe_id')).toMatchObject({ widget: 'food-picker', pick: 'recipe' });
    expect(child(intake, 'note').widget).toBe('text');
  });

  it('maps booleans, integers, multi-selects and nullable objects', () => {
    const outtake = formFor(payloadSchema('outtake'));
    expect(child(outtake, 'bristol')).toMatchObject({
      widget: 'integer',
      min: 1,
      max: 7,
      required: true,
    });
    expect(child(outtake, 'urgency').widget).toBe('boolean');
    expect(child(outtake, 'flags')).toMatchObject({ widget: 'multi-enum' });
    expect(child(outtake, 'flags').item!.options).toEqual(['blood', 'mucus', 'undigested']);
    const stages = child(formFor(payloadSchema('sleep')), 'stages');
    expect(stages).toMatchObject({ widget: 'object', nullable: true });
    expect(stages.fields.map((field) => field.label)).toEqual([
      'Deep (min)',
      'Light (min)',
      'Rem (min)',
      'Awake (min)',
    ]);
  });

  it('maps dates and nested exercise sets', () => {
    expect(child(formFor(commandSchema('update_profile')), 'goal_date').widget).toBe('date');
    const exercises = child(formFor(payloadSchema('workout')), 'exercises');
    expect(child(exercises.item!, 'sets').item!.fields.map((field) => field.key)).toEqual([
      'reps',
      'weight_kg',
      'duration_s',
      'rpe',
    ]);
  });
});

describe('labelFor', () => {
  it('puts units in brackets', () => {
    expect(labelFor('goal_weight_kg')).toBe('Goal weight (kg)');
    expect(labelFor('fat_g_per_kg_min')).toBe('Fat (g/kg, minimum)');
    expect(labelFor('efficiency_pct')).toBe('Efficiency (%)');
    expect(labelFor('body_area')).toBe('Body area');
    expect(labelFor('food_id')).toBe('Food');
  });
});

describe('initialValue and clean', () => {
  it('starts a recipe with its defaults', () => {
    expect(initialValue(formFor(commandSchema('save_recipe'), ['id']))).toEqual({
      name: null,
      serves: 1,
      items: [],
    });
  });

  it('keeps only schema keys, so a stored intake can be sent back', () => {
    const intake = formFor(payloadSchema('intake'));
    const stored = {
      slot: 'breakfast',
      items: [{ food_id: 'f1', food_version_id: 'v1', name: 'Oats', grams: 80, nutrients: {} }],
      recipe_id: null,
      recipe_version_id: null,
      portions: null,
      note: '',
      nutrients: { kcal: 300 },
    };
    expect(clean(intake, stored)).toEqual({
      slot: 'breakfast',
      items: [{ food_id: 'f1', grams: 80 }],
      recipe_id: null,
      portions: null,
      note: null,
    });
  });

  it('leaves out an empty required input so the backend names it', () => {
    expect(clean(formFor(payloadSchema('outtake')), { bristol: null, flags: ['mucus'] })).toEqual({
      urgency: null,
      pain: null,
      flags: ['mucus'],
      note: null,
    });
  });
});

describe('fieldUnder', () => {
  it('strips the form prefix from an error path', () => {
    expect(fieldUnder('events.0.payload.items.0.grams', 'events.0.payload')).toBe('items.0.grams');
    expect(fieldUnder('events.0.occurred_at', 'events.0.payload')).toBeNull();
    expect(fieldUnder('name', '')).toBe('name');
    expect(fieldUnder(null, '')).toBeNull();
  });
});

describe('updateIn', () => {
  it('replaces a nested value without touching the original', () => {
    const root = { items: [{ food_id: 'a', grams: 1 }], note: 'x' };
    const next = updateIn(root, ['items', 0, 'grams'], () => 80);
    expect(next).toEqual({ items: [{ food_id: 'a', grams: 80 }], note: 'x' });
    expect(root.items[0].grams).toBe(1);
    expect(updateIn(undefined, ['stages', 'deep_min'], () => 5)).toEqual({
      stages: { deep_min: 5 },
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- --include src/app/shared/forms/schema.spec.ts`
Expected: the build fails with `Could not resolve "./schema"`.

- [ ] **Step 3: Implement**

`src/app/shared/forms/schema.ts`:

```ts
/** The subset of JSON Schema (as pydantic writes it) that the form renderer reads. */
export interface JsonSchema {
  type?: string;
  format?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  maxLength?: number;
  pattern?: string;
  maxItems?: number;
}

export type Widget =
  | 'number'
  | 'integer'
  | 'string'
  | 'text'
  | 'enum'
  | 'boolean'
  | 'date-time'
  | 'date'
  | 'object'
  | 'array'
  | 'multi-enum'
  | 'food-picker';

/** One input of a generated form; objects and arrays nest further fields. */
export interface Field {
  key: string;
  label: string;
  hint: string | null;
  widget: Widget;
  required: boolean;
  nullable: boolean;
  options: string[];
  min: number | null;
  max: number | null;
  maxLength: number | null;
  pattern: string | null;
  maxItems: number | null;
  initial: unknown;
  fields: Field[];
  item: Field | null;
  pick: 'food' | 'recipe' | null;
}

const TEXT_FROM_LENGTH = 500;
const ALWAYS_HIDDEN = ['idempotency_key'];
const UNIT_SUFFIXES: [string, string][] = [
  ['_g_per_kg_min', 'g/kg, minimum'],
  ['_g_per_kg', 'g/kg'],
  ['_kg', 'kg'],
  ['_g', 'g'],
  ['_ml', 'ml'],
  ['_cm', 'cm'],
  ['_km', 'km'],
  ['_min', 'min'],
  ['_pct', '%'],
  ['_bpm', 'bpm'],
  ['_s', 's'],
];

/** "stomach_ache" → "Stomach ache". */
export function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A property name as a label: units in brackets ("goal_weight_kg" → "Goal weight (kg)"), no "id". */
export function labelFor(key: string): string {
  if (key.endsWith('_id')) {
    return humanize(key.slice(0, -3));
  }
  for (const [suffix, unit] of UNIT_SUFFIXES) {
    if (key.endsWith(suffix) && key.length > suffix.length) {
      return `${humanize(key.slice(0, -suffix.length))} (${unit})`;
    }
  }
  return humanize(key);
}

function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) {
    return schema;
  }
  const name = schema.$ref.replace('#/$defs/', '');
  const target = root.$defs?.[name];
  if (!target) {
    throw new Error(`unresolved schema reference ${schema.$ref}`);
  }
  return target;
}

function widgetFor(key: string, schema: JsonSchema, item: Field | null): Widget {
  if (key === 'food_id' || key === 'recipe_id') {
    return 'food-picker';
  }
  if (schema.enum) {
    return 'enum';
  }
  switch (schema.type) {
    case 'boolean':
    case 'integer':
    case 'number':
    case 'object':
      return schema.type;
    case 'array':
      return item?.widget === 'enum' ? 'multi-enum' : 'array';
    case 'string':
      if (schema.format === 'date-time' || schema.format === 'date') {
        return schema.format;
      }
      return (schema.maxLength ?? 0) >= TEXT_FROM_LENGTH ? 'text' : 'string';
  }
  throw new Error(`no form widget for "${key}" (${JSON.stringify(schema).slice(0, 80)})`);
}

/** Turn a (sub)schema into a Field; `root` holds the $defs that references point into. */
export function toField(
  schema: JsonSchema,
  root: JsonSchema = schema,
  key = '',
  required = false,
): Field {
  const outer = resolve(schema, root);
  const variants = outer.anyOf?.filter((variant) => variant.type !== 'null');
  if (variants && variants.length !== 1) {
    throw new Error(`no form widget for the union at "${key}"`);
  }
  const inner = variants ? resolve(variants[0], root) : outer;
  const item = inner.type === 'array' && inner.items ? toField(inner.items, root, '', true) : null;
  const requiredKeys = inner.required ?? [];
  const fields = Object.entries(inner.properties ?? {})
    .filter(([name]) => !ALWAYS_HIDDEN.includes(name))
    .map(([name, child]) => toField(child, root, name, requiredKeys.includes(name)));
  const widget = widgetFor(key, inner, item);
  return {
    key,
    label: labelFor(key),
    hint: outer.description ?? inner.description ?? null,
    widget,
    required,
    nullable: Boolean(variants),
    options: inner.enum ?? [],
    min: inner.minimum ?? inner.exclusiveMinimum ?? null,
    max: inner.maximum ?? inner.exclusiveMaximum ?? null,
    maxLength: inner.maxLength ?? null,
    pattern: inner.pattern ?? null,
    maxItems: inner.maxItems ?? null,
    initial: outer.default ?? null,
    fields,
    item,
    pick: widget === 'food-picker' ? (key === 'recipe_id' ? 'recipe' : 'food') : null,
  };
}

/** The root field of a form for a command or payload schema, minus the keys in `omit`. */
export function formFor(schema: JsonSchema, omit: string[] = []): Field {
  const root = toField(schema, schema, '', true);
  return { ...root, fields: root.fields.filter((field) => !omit.includes(field.key)) };
}

/** A fresh value for a field: objects get their required children, arrays start empty. */
export function initialValue(field: Field): unknown {
  if (field.widget === 'object') {
    return Object.fromEntries(
      field.fields
        .filter((child) => child.required || child.initial !== null)
        .map((child) => [child.key, initialValue(child)]),
    );
  }
  if (field.widget === 'array' || field.widget === 'multi-enum') {
    return [];
  }
  return field.initial ?? null;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The value to send: only keys the schema knows, empty optional inputs as null (so they
 * clear) or left out (when null is not allowed), and empty required inputs left out so the
 * backend names them.
 */
export function clean(field: Field, value: unknown): unknown {
  if (field.widget === 'object') {
    if (isEmpty(value)) {
      return field.nullable ? null : undefined;
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const child of field.fields) {
      const cleaned = clean(child, source[child.key]);
      if (cleaned !== undefined) {
        result[child.key] = cleaned;
      }
    }
    return result;
  }
  if (field.widget === 'array' || field.widget === 'multi-enum') {
    const items = Array.isArray(value) ? value : [];
    return field.item ? items.map((item) => clean(field.item!, item) ?? null) : items;
  }
  if (isEmpty(value)) {
    return field.nullable ? null : undefined;
  }
  return value;
}

/** An error field path relative to a form rooted at `prefix` ("events.0.payload"). */
export function fieldUnder(path: string | null | undefined, prefix: string): string | null {
  if (!path) {
    return null;
  }
  if (!prefix) {
    return path;
  }
  return path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : null;
}

/** A position inside a form value: property names and array indexes. */
export type Path = (string | number)[];

/** A copy of `root` with the value at `path` replaced by `change(current)`. */
export function updateIn(
  root: unknown,
  path: Path,
  change: (current: unknown) => unknown,
): unknown {
  if (!path.length) {
    return change(root);
  }
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...root] : [];
    list[head] = updateIn(list[head], rest, change);
    return list;
  }
  const record = root && typeof root === 'object' ? { ...(root as Record<string, unknown>) } : {};
  record[head] = updateIn(record[head], rest, change);
  return record;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  53 passed (53)`. If a new backend field makes `toField` throw `no form
widget for …`, the renderer needs that widget; do not skip the field.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): JSON-Schema field model for generated forms

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Form components and the food picker

**Files:**
- Create: `frontend/src/app/shared/forms/field-view.ts`, `frontend/src/app/shared/forms/schema-form.ts`, `frontend/src/app/shared/forms/food-picker.ts`
- Test: `frontend/src/app/shared/forms/schema-form.spec.ts`

**Interfaces:**
- Consumes: `Field`, `Path`, `humanize`, `initialValue`, `updateIn` (Task 4); `Api`,
  `errorText` (Task 1); `fromLocalInput`, `toLocalInput` (Task 3).
- Produces:
  - `<app-schema-form [field] [(value)] [errorPath] [errorMessage]>`: `value` is a
    `model<Record<string, unknown>>`; `errorPath` is relative to the form root
    ("items.0.grams"); the matching input gets `.invalid` and the message below it.
  - `<app-field>` (`FieldView`, recursive): inputs `field`, `value`, `path: Path`,
    `edit: Edit`, `errorPath`, `errorMessage`. Every input carries `name="<path joined
    by dots>"`. `type Edit = (path: Path, change: (current: unknown) => unknown) => void`
    applies every change to the latest root value, so quick successive edits never
    overwrite each other.
  - `<app-food-picker [pick]="'food' | 'recipe'" [value] (picked)>`: searches
    `views/catalog` (local foods first, then usable Open Food Facts hits, which are imported
    with `import_food` when chosen) or `views/recipes` (filtered by name), 250 ms after
    typing; shows the chosen item's name (loaded by id for an existing value).

- [ ] **Step 1: Write the failing test**

`src/app/shared/forms/schema-form.spec.ts` (renders every payload kind, edits nested
values, shows a backend error at its field, and imports a remote food through the picker):

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTestConfig } from '../../../testing/config';
import { payloadSchema } from '../../../testing/schemas';
import { Field, formFor } from './schema';
import { SchemaForm } from './schema-form';

@Component({
  imports: [SchemaForm],
  template: `<app-schema-form
    [field]="field()"
    [(value)]="value"
    [errorPath]="errorPath()"
    errorMessage="Input should be less than or equal to 7"
  />`,
})
class Host {
  readonly field = signal<Field>(formFor(payloadSchema('outtake')));
  readonly value = signal<Record<string, unknown>>({});
  readonly errorPath = signal<string | null>(null);
}

describe('SchemaForm', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let element: HTMLElement;
  let backend: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideTestConfig(), provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    element = fixture.nativeElement;
    backend = TestBed.inject(HttpTestingController);
    await fixture.whenStable();
  });

  function input(name: string): HTMLInputElement {
    const found = element.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!found) {
      throw new Error(`no input ${name}`);
    }
    return found;
  }

  function type(name: string, text: string): void {
    const target = input(name);
    target.value = text;
    target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input'));
  }

  function click(text: string): void {
    const button = [...element.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    );
    if (!button) {
      throw new Error(`no button ${text}`);
    }
    button.click();
  }

  it.each([
    ['intake', ['slot', 'recipe_id', 'portions', 'note']],
    ['outtake', ['bristol', 'urgency', 'pain', 'note']],
    ['symptom', ['type', 'severity', 'body_area', 'note']],
    ['medication', ['name', 'dose', 'unit', 'reason', 'note']],
    ['supplement', ['name', 'dose', 'unit', 'reason', 'note']],
    ['sleep', ['quality', 'efficiency_pct', 'note']],
    ['activity', ['steps', 'active_minutes', 'distance_km']],
    ['workout', ['title', 'category', 'set_count', 'volume_kg', 'note']],
    ['measurement', ['metric', 'value', 'unit']],
    ['checkin', ['overall', 'energy', 'mood', 'stress', 'note']],
    ['note', ['text']],
  ])('renders the %s payload form', async (kind, names) => {
    host.field.set(formFor(payloadSchema(kind)));
    await fixture.whenStable();
    const rendered = [...element.querySelectorAll('[name]')].map((node) =>
      node.getAttribute('name'),
    );
    for (const name of names) {
      if (name === 'recipe_id') {
        expect(element.querySelector('app-food-picker')).not.toBeNull();
      } else {
        expect(rendered).toContain(name);
      }
    }
  });

  it('writes typed numbers, enums and multi-selects into the value', async () => {
    type('bristol', '4');
    type('note', 'after coffee');
    const mucus = [...element.querySelectorAll<HTMLLabelElement>('label.check')].find((label) =>
      label.textContent?.includes('Mucus'),
    )!;
    mucus.querySelector('input')!.click();
    await fixture.whenStable();
    expect(host.value()).toEqual({ bristol: 4, note: 'after coffee', flags: ['mucus'] });
    type('bristol', '');
    await fixture.whenStable();
    expect(host.value()['bristol']).toBeNull();
  });

  it('adds and removes array items and optional objects', async () => {
    host.field.set(formFor(payloadSchema('sleep')));
    await fixture.whenStable();
    click('Add Stages');
    await fixture.whenStable();
    type('stages.deep_min', '90');
    await fixture.whenStable();
    expect(host.value()).toEqual({
      stages: { deep_min: 90, light_min: null, rem_min: null, awake_min: null },
    });
    click('Remove Stages');
    await fixture.whenStable();
    expect(host.value()).toEqual({ stages: null });

    host.field.set(formFor(payloadSchema('workout')));
    host.value.set({});
    await fixture.whenStable();
    click('Add');
    await fixture.whenStable();
    type('exercises.0.name', 'Squat');
    await fixture.whenStable();
    expect(host.value()['exercises']).toEqual([{ name: 'Squat', category: null }]);
    click('Remove');
    await fixture.whenStable();
    expect(host.value()['exercises']).toEqual([]);
  });

  it('shows the backend error at its field', async () => {
    host.errorPath.set('bristol');
    await fixture.whenStable();
    expect(input('bristol').closest('label')!.classList).toContain('invalid');
    expect(element.querySelector('.field-error')!.textContent).toContain('less than or equal to 7');
  });

  it('picks a remote food by importing it', async () => {
    host.field.set(formFor(payloadSchema('intake')));
    await fixture.whenStable();
    click('Add');
    await fixture.whenStable();
    const search = element.querySelector<HTMLInputElement>('app-food-picker input')!;
    search.value = 'skyr';
    search.dispatchEvent(new Event('input'));
    const lookup = await vi.waitFor(() =>
      backend.expectOne((r) => r.url === '/api/v2/views/catalog' && r.params.get('q') === 'skyr'),
    );
    lookup.flush({
      local: [],
      remote: [
        { barcode: '4001234', name: 'Skyr', brand: 'Arla', per_100: { kcal: 63 }, usable: true },
      ],
      remote_error: null,
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      click('Skyr Arla · Open Food Facts');
    });
    backend.expectOne('/api/v2/commands/import_food').flush({
      result: { id: 'food-1', name: 'Skyr' },
      effects: { days: [] },
      warnings: [],
    });
    await vi.waitFor(() =>
      expect(host.value()['items']).toEqual([{ food_id: 'food-1', grams: null }]),
    );
    await fixture.whenStable();
    backend.expectOne((r) => r.url === '/api/v2/views/food').flush({ id: 'food-1', name: 'Skyr' });
    expect(element.querySelector('app-food-picker .chosen')!.textContent).toContain('Skyr');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- --include src/app/shared/forms/schema-form.spec.ts`
Expected: the build fails with `Could not resolve "./schema-form"`.

- [ ] **Step 3: Implement**

`src/app/shared/forms/food-picker.ts`:

```ts
import { Component, effect, inject, input, output, signal } from '@angular/core';
import { Api } from '../../core/api/api';
import { errorText } from '../../core/api/errors';

interface Choice {
  id: string | null;
  barcode: string | null;
  name: string;
  detail: string;
}

const SEARCH_DELAY_MS = 250;
const MAX_CHOICES = 8;

/** Search the catalog (foods incl. Open Food Facts, or recipes) and emit the chosen id. */
@Component({
  selector: 'app-food-picker',
  template: `
    @if (value() && !searching()) {
      <div class="chosen">
        <span>{{ name() ?? '…' }}</span>
        <button type="button" class="link" (click)="searching.set(true)">Change</button>
      </div>
    } @else {
      <input
        type="search"
        [placeholder]="pick() === 'food' ? 'Search foods' : 'Search recipes'"
        [value]="query()"
        (input)="search($any($event.target).value)"
      />
      @if (error()) {
        <p class="field-error">{{ error() }}</p>
      }
      <ul class="choices">
        @for (choice of choices(); track choice.id ?? choice.barcode) {
          <li>
            <button type="button" (click)="choose(choice)">
              {{ choice.name }} <small>{{ choice.detail }}</small>
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class FoodPicker {
  private readonly api = inject(Api);
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly pick = input.required<'food' | 'recipe'>();
  readonly value = input<unknown>(null);
  readonly picked = output<string>();

  protected readonly name = signal<string | null>(null);
  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly choices = signal<Choice[]>([]);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.value();
      if (typeof id === 'string' && id) {
        void this.loadName(id);
      }
    });
  }

  protected search(text: string): void {
    this.query.set(text);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(text.trim()), SEARCH_DELAY_MS);
  }

  protected async choose(choice: Choice): Promise<void> {
    try {
      const id =
        choice.id ??
        (await this.api.command('import_food', { barcode: choice.barcode! })).result.id;
      this.name.set(choice.name);
      this.searching.set(false);
      this.choices.set([]);
      this.picked.emit(id);
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  private async run(text: string): Promise<void> {
    this.error.set(null);
    if (text.length < 2) {
      this.choices.set([]);
      return;
    }
    try {
      const choices = this.pick() === 'food' ? await this.foods(text) : await this.recipes(text);
      this.choices.set(choices.slice(0, MAX_CHOICES));
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  private async foods(text: string): Promise<Choice[]> {
    const found = await this.api.view('catalog', { q: text });
    if (found.remote_error) {
      this.error.set(`Open Food Facts: ${found.remote_error}`);
    }
    return [
      ...found.local.map((food) => ({
        id: food.id,
        barcode: food.barcode,
        name: food.name,
        detail: [food.brand, `${food.per_100.kcal} kcal/100`].filter(Boolean).join(' · '),
      })),
      ...found.remote
        .filter((food) => food.usable)
        .map((food) => ({
          id: null,
          barcode: food.barcode,
          name: food.name,
          detail: [food.brand, 'Open Food Facts'].filter(Boolean).join(' · '),
        })),
    ];
  }

  private async recipes(text: string): Promise<Choice[]> {
    const { recipes } = await this.api.view('recipes');
    const needle = text.toLowerCase();
    return recipes
      .filter((recipe) => recipe.name.toLowerCase().includes(needle))
      .map((recipe) => ({
        id: recipe.id,
        barcode: null,
        name: recipe.name,
        detail: `${Math.round(recipe.per_portion.kcal ?? 0)} kcal/portion`,
      }));
  }

  private async loadName(id: string): Promise<void> {
    try {
      const found =
        this.pick() === 'food'
          ? await this.api.view('food', { id })
          : await this.api.view('recipe', { id });
      this.name.set(found.name);
    } catch {
      this.name.set(id);
    }
  }
}
```

`src/app/shared/forms/field-view.ts`:

```ts
import { Component, computed, input } from '@angular/core';
import { fromLocalInput, toLocalInput } from '../time';
import { FoodPicker } from './food-picker';
import { Field, Path, humanize, initialValue } from './schema';

/** Applies a change at a path to the whole form value. */
export type Edit = (path: Path, change: (current: unknown) => unknown) => void;

/** One generated input; objects and arrays render their children with this component again. */
@Component({
  selector: 'app-field',
  imports: [FoodPicker],
  template: `
    @let f = field();
    @switch (f.widget) {
      @case ('object') {
        <fieldset [class.invalid]="invalid()">
          @if (f.key) {
            <legend>{{ f.label }}</legend>
          }
          @if (record(); as current) {
            @for (child of f.fields; track child.key) {
              <app-field
                [field]="child"
                [value]="current[child.key]"
                [path]="at(child.key)"
                [edit]="edit()"
                [errorPath]="errorPath()"
                [errorMessage]="errorMessage()"
              />
            }
            @if (f.nullable) {
              <button type="button" class="link" (click)="set(null)">Remove {{ f.label }}</button>
            }
          } @else {
            <button type="button" class="link" (click)="set(fresh(f))">Add {{ f.label }}</button>
          }
        </fieldset>
      }
      @case ('array') {
        <fieldset [class.invalid]="invalid()">
          <legend>{{ f.label }}</legend>
          @for (item of list(); track $index) {
            <div class="array-item">
              <app-field
                [field]="f.item!"
                [value]="item"
                [path]="at($index)"
                [edit]="edit()"
                [errorPath]="errorPath()"
                [errorMessage]="errorMessage()"
              />
              <button type="button" class="link" (click)="removeIndex($index)">Remove</button>
            </div>
          }
          @if (f.maxItems === null || list().length < f.maxItems) {
            <button type="button" class="link" (click)="append()">Add</button>
          }
        </fieldset>
      }
      @case ('multi-enum') {
        <fieldset [class.invalid]="invalid()">
          <legend>{{ f.label }}</legend>
          @for (option of f.item!.options; track option) {
            <label class="check">
              <input
                type="checkbox"
                [checked]="list().includes(option)"
                (change)="toggle(option)"
              />
              {{ words(option) }}
            </label>
          }
        </fieldset>
      }
      @default {
        <label [class.invalid]="invalid()">
          <span class="label"
            >{{ f.label }}
            @if (f.required) {
              <b aria-hidden="true"> *</b>
            }
          </span>
          @switch (f.widget) {
            @case ('food-picker') {
              <app-food-picker [pick]="f.pick!" [value]="value()" (picked)="set($event)" />
            }
            @case ('enum') {
              <select [attr.name]="name()" (change)="emitText($any($event.target).value)">
                <option value="" [selected]="value() == null">–</option>
                @for (option of f.options; track option) {
                  <option [value]="option" [selected]="value() === option">
                    {{ words(option) }}
                  </option>
                }
              </select>
            }
            @case ('boolean') {
              <input
                type="checkbox"
                [attr.name]="name()"
                [checked]="value() === true"
                (change)="set($any($event.target).checked)"
              />
            }
            @case ('text') {
              <textarea
                rows="3"
                [attr.name]="name()"
                [attr.maxlength]="f.maxLength"
                [value]="value() ?? ''"
                (input)="emitText($any($event.target).value)"
              ></textarea>
            }
            @case ('date-time') {
              <input
                type="datetime-local"
                [attr.name]="name()"
                [value]="value() ? local(value()) : ''"
                (change)="emitDateTime($any($event.target).value)"
              />
            }
            @case ('date') {
              <input
                type="date"
                [attr.name]="name()"
                [value]="value() ?? ''"
                (change)="emitText($any($event.target).value)"
              />
            }
            @case ('number') {
              <input
                type="number"
                inputmode="decimal"
                step="any"
                [attr.name]="name()"
                [attr.min]="f.min"
                [attr.max]="f.max"
                [value]="value() ?? ''"
                (input)="emitNumber($any($event.target).value)"
              />
            }
            @case ('integer') {
              <input
                type="number"
                inputmode="numeric"
                step="1"
                [attr.name]="name()"
                [attr.min]="f.min"
                [attr.max]="f.max"
                [value]="value() ?? ''"
                (input)="emitNumber($any($event.target).value)"
              />
            }
            @default {
              <input
                type="text"
                [attr.name]="name()"
                [attr.maxlength]="f.maxLength"
                [attr.pattern]="f.pattern"
                [value]="value() ?? ''"
                (input)="emitText($any($event.target).value)"
              />
            }
          }
          @if (f.hint) {
            <small class="hint">{{ f.hint }}</small>
          }
        </label>
      }
    }
    @if (invalid()) {
      <p class="field-error">{{ errorMessage() }}</p>
    }
  `,
})
export class FieldView {
  readonly field = input.required<Field>();
  readonly value = input<unknown>(null);
  readonly path = input<Path>([]);
  readonly edit = input.required<Edit>();
  readonly errorPath = input<string | null>(null);
  readonly errorMessage = input('');

  protected readonly name = computed(() => this.path().join('.'));
  protected readonly invalid = computed(
    () => this.errorPath() !== null && this.errorPath() === this.name(),
  );
  protected readonly record = computed(() => {
    const value = this.value();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  });
  protected readonly list = computed(() => {
    const value = this.value();
    return Array.isArray(value) ? (value as unknown[]) : [];
  });
  protected readonly words = humanize;
  protected readonly fresh = initialValue;
  protected readonly local = (value: unknown) => toLocalInput(String(value));

  protected at(key: string | number): Path {
    return [...this.path(), key];
  }

  protected set(value: unknown): void {
    this.edit()(this.path(), () => value);
  }

  protected removeIndex(index: number): void {
    this.edit()(this.path(), (current) =>
      (Array.isArray(current) ? current : []).filter((_, at) => at !== index),
    );
  }

  protected append(): void {
    const item = initialValue(this.field().item!);
    this.edit()(this.path(), (current) => [...(Array.isArray(current) ? current : []), item]);
  }

  protected toggle(option: string): void {
    this.edit()(this.path(), (current) => {
      const list = Array.isArray(current) ? current : [];
      return list.includes(option) ? list.filter((item) => item !== option) : [...list, option];
    });
  }

  protected emitText(text: string): void {
    this.set(text === '' ? null : text);
  }

  protected emitNumber(text: string): void {
    this.set(text === '' ? null : Number(text));
  }

  protected emitDateTime(text: string): void {
    this.set(text === '' ? null : fromLocalInput(text));
  }
}
```

`src/app/shared/forms/schema-form.ts`:

```ts
import { Component, input, model } from '@angular/core';
import { Edit, FieldView } from './field-view';
import { Field, updateIn } from './schema';

/** A form generated from a JSON Schema field tree; `value` is two-way bound. */
@Component({
  selector: 'app-schema-form',
  imports: [FieldView],
  template: `
    <app-field
      [field]="field()"
      [value]="value()"
      [edit]="edit"
      [errorPath]="errorPath()"
      [errorMessage]="errorMessage()"
    />
  `,
})
export class SchemaForm {
  readonly field = input.required<Field>();
  readonly value = model.required<Record<string, unknown>>();
  readonly errorPath = input<string | null>(null);
  readonly errorMessage = input('');

  protected readonly edit: Edit = (path, change) =>
    this.value.update((root) => updateIn(root, path, change) as Record<string, unknown>);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  68 passed (68)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): schema form renderer with nested objects, lists and the food picker

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Gauge and timeline

**Files:**
- Create: `frontend/src/app/shared/gauge/gauge.ts`, `frontend/src/app/shared/timeline/describe.ts`, `frontend/src/app/shared/timeline/timeline.ts`, `frontend/src/app/shared/timeline/day-summary.ts`, `frontend/src/app/shared/timeline/visible.ts`, `frontend/src/testing/events.ts`
- Test: `frontend/src/app/shared/gauge/gauge.spec.ts`, `frontend/src/app/shared/timeline/describe.spec.ts`, `frontend/src/app/shared/timeline/timeline.spec.ts`

**Interfaces:**
- Consumes: `Gauge`, `DaySummary`, `EventOut`, `Kind` (Task 1); `humanize` (Task 4);
  `clock`, `duration` (Task 3).
- Produces:
  - `<app-gauge [gauge]>` (`GaugeView`): label (Energy/Protein/Carbs/Fat), rounded value
    with unit, a `role="meter"` bar filled to `min(ratio, 1)`, and the text
    "850 kcal left of 2300" / "25 g over 70" / "no target"; `data-state` is
    `under | near | over | none` (near = within ±10 %).
  - `describeEvent(event) → Line { title; detail }` for all 11 kinds,
    `kindLabel(kind)`, `KINDS: Kind[]` (intake … note, spec order).
  - `<app-timeline [events] [emptyText]>`: one `<li>` per event with
    `<time datetime=occurred_at>HH:mm</time>`, title, detail, a source badge when the
    source is not `app`, an "edited" badge from version 2, strike-through when retracted;
    each row links to `/event/<chain_id>`.
  - `<app-day-summary [summary]>`: the four gauges (2×2 on a phone, 4 in a row from
    40rem) and a one-line list of the day's other totals.
  - `[appVisible]` directive: emits when its element scrolls within 400 px of the viewport.
  - Spec helper `event(overrides)`.

- [ ] **Step 1: Write the failing tests**

`src/testing/events.ts`:

```ts
import type { EventOut } from '../app/core/api/types';

/** An EventOut with sensible defaults; override what the test is about. */
export function event(overrides: Partial<EventOut> = {}): EventOut {
  return {
    id: 'e-1',
    chain_id: 'c-1',
    version: 1,
    kind: 'note',
    occurred_at: '2026-09-29T08:15:00Z',
    ends_at: null,
    local_day: '2026-09-29',
    payload: { text: 'hello' },
    source: 'app',
    recorded_at: '2026-09-29T08:15:05Z',
    retracted: false,
    links: [],
    ...overrides,
  };
}
```

`src/app/shared/gauge/gauge.spec.ts`:

```ts
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

  it('shows value, remainder and a proportional fill', async () => {
    const element = await render({ name: 'kcal', value: 1450.4, target: 2300, ratio: 0.63 });
    expect(element.querySelector('.name')!.textContent).toBe('Energy');
    expect(element.querySelector('.value')!.textContent).toBe('1450kcal');
    expect(element.querySelector('.rest')!.textContent).toBe('850 kcal left of 2300');
    expect(element.querySelector<HTMLElement>('.fill')!.style.width).toBe('63%');
    expect(element.querySelector('.gauge')!.getAttribute('data-state')).toBe('under');
  });

  it('caps the fill and says how far over the target it is', async () => {
    const element = await render({ name: 'fat', value: 95, target: 70, ratio: 1.36 });
    expect(element.querySelector<HTMLElement>('.fill')!.style.width).toBe('100%');
    expect(element.querySelector('.rest')!.textContent).toBe('25 g over 70');
    expect(element.querySelector('.gauge')!.getAttribute('data-state')).toBe('over');
  });

  it('says when there is no target', async () => {
    const element = await render({ name: 'protein', value: 40, target: null, ratio: null });
    expect(element.querySelector('.rest')!.textContent).toBe('no target');
    expect(element.querySelector('.gauge')!.getAttribute('data-state')).toBe('none');
  });
});
```

`src/app/shared/timeline/describe.spec.ts`:

```ts
import { event } from '../../../testing/events';
import { describeEvent } from './describe';

describe('describeEvent', () => {
  it('sums up an intake with its items and macros', () => {
    const line = describeEvent(
      event({
        kind: 'intake',
        payload: {
          slot: 'breakfast',
          items: [
            { name: 'Oats', grams: 80 },
            { name: 'Skyr', grams: 250 },
          ],
          nutrients: { kcal: 452.6, protein_g: 38.2, carbs_g: 55, fat_g: 7.9 },
        },
      }),
    );
    expect(line).toEqual({
      title: 'Breakfast · Oats, Skyr',
      detail: '453 kcal · P 38 g · C 55 g · F 8 g',
    });
  });

  it('describes each other kind in one line', () => {
    expect(
      describeEvent(event({ kind: 'outtake', payload: { bristol: 4, flags: ['mucus'] } })),
    ).toEqual({
      title: 'Bowel movement',
      detail: 'Bristol 4 · mucus',
    });
    expect(
      describeEvent(event({ kind: 'symptom', payload: { type: 'stomach_ache', severity: 3 } })),
    ).toEqual({ title: 'Stomach ache', detail: 'severity 3/5' });
    expect(
      describeEvent(
        event({
          kind: 'sleep',
          occurred_at: '2026-09-28T22:40:00Z',
          ends_at: '2026-09-29T06:00:00Z',
          payload: { quality: 4 },
        }),
      ),
    ).toEqual({ title: 'Sleep', detail: '7 h 20 min · quality 4/5' });
    expect(
      describeEvent(
        event({ kind: 'measurement', payload: { metric: 'weight_kg', value: 81.4, unit: 'kg' } }),
      ),
    ).toEqual({ title: 'Weight', detail: '81.4 kg' });
    expect(
      describeEvent(
        event({ kind: 'medication', payload: { name: 'Ibuprofen', dose: 400, unit: 'mg' } }),
      ),
    ).toEqual({ title: 'Ibuprofen', detail: '400 mg' });
  });
});
```

`src/app/shared/timeline/timeline.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { event } from '../../../testing/events';
import { Timeline } from './timeline';

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
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./gauge"`, `"./describe"` and `"./timeline"`.

- [ ] **Step 3: Implement**

`src/app/shared/gauge/gauge.ts`:

```ts
import { Component, computed, input } from '@angular/core';
import type { Gauge } from '../../core/api/types';

const LABELS: Record<Gauge['name'], string> = {
  kcal: 'Energy',
  protein: 'Protein',
  carbs: 'Carbs',
  fat: 'Fat',
};
const NEAR = 0.1;

/** One day gauge: value against target as a meter, with the remainder spelled out. */
@Component({
  selector: 'app-gauge',
  template: `
    <div class="gauge" [attr.data-state]="state()">
      <span class="name">{{ label() }}</span>
      <span class="value"
        >{{ value() }}<small>{{ unit() }}</small></span
      >
      <div
        class="meter"
        role="meter"
        [attr.aria-label]="label()"
        [attr.aria-valuenow]="gauge().value"
        aria-valuemin="0"
        [attr.aria-valuemax]="gauge().target"
      >
        <div class="fill" [style.width.%]="fill()"></div>
      </div>
      <span class="rest">{{ rest() }}</span>
    </div>
  `,
  styles: `
    .gauge {
      display: grid;
      gap: 0.25rem;
      padding: 0.75rem;
      border-radius: 0.75rem;
      background: var(--surface);
      border: 1px solid var(--line);
    }
    .name {
      color: var(--ink-2);
      font-size: 0.85rem;
    }
    .value {
      font-size: 1.5rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .value small {
      font-size: 0.8rem;
      font-weight: 400;
      color: var(--ink-2);
      margin-left: 0.15rem;
    }
    .meter {
      height: 0.5rem;
      border-radius: 0.25rem;
      background: var(--track);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      border-radius: 0.25rem;
      background: var(--accent);
    }
    [data-state='over'] .fill {
      background: var(--warning);
    }
    .rest {
      color: var(--ink-2);
      font-size: 0.8rem;
    }
  `,
})
export class GaugeView {
  readonly gauge = input.required<Gauge>();

  protected readonly label = computed(() => LABELS[this.gauge().name]);
  protected readonly unit = computed(() => (this.gauge().name === 'kcal' ? 'kcal' : 'g'));
  protected readonly value = computed(() => Math.round(this.gauge().value));
  protected readonly fill = computed(() => Math.min(1, this.gauge().ratio ?? 0) * 100);
  protected readonly state = computed(() => {
    const ratio = this.gauge().ratio;
    if (ratio === null) {
      return 'none';
    }
    return ratio > 1 + NEAR ? 'over' : ratio >= 1 - NEAR ? 'near' : 'under';
  });
  protected readonly rest = computed(() => {
    const { value, target } = this.gauge();
    if (target === null) {
      return 'no target';
    }
    const difference = Math.round(target - value);
    return difference >= 0
      ? `${difference} ${this.unit()} left of ${Math.round(target)}`
      : `${-difference} ${this.unit()} over ${Math.round(target)}`;
  });
}
```

`src/app/shared/timeline/describe.ts`:

```ts
import type { EventOut, Kind } from '../../core/api/types';
import { humanize } from '../forms/schema';
import { duration } from '../time';

/** What a timeline row says about an event. */
export interface Line {
  title: string;
  detail: string;
}

type Payload = Record<string, unknown>;

const KIND_LABELS: Record<Kind, string> = {
  intake: 'Meal',
  outtake: 'Bowel movement',
  symptom: 'Symptom',
  medication: 'Medication',
  supplement: 'Supplement',
  sleep: 'Sleep',
  activity: 'Activity',
  workout: 'Workout',
  measurement: 'Measurement',
  checkin: 'Check-in',
  note: 'Note',
};

const round = (value: unknown) => Math.round(Number(value ?? 0));
const parts = (...values: unknown[]) => values.filter((value) => value || value === 0).join(' · ');

function intake(payload: Payload): Line {
  const items = (payload['items'] as { name: string; grams: number }[] | undefined) ?? [];
  const nutrients = (payload['nutrients'] as Payload | undefined) ?? {};
  const slot = payload['slot'] ? humanize(String(payload['slot'])) : 'Meal';
  return {
    title: parts(slot, items.map((item) => item.name).join(', ')),
    detail: parts(
      `${round(nutrients['kcal'])} kcal`,
      `P ${round(nutrients['protein_g'])} g`,
      `C ${round(nutrients['carbs_g'])} g`,
      `F ${round(nutrients['fat_g'])} g`,
    ),
  };
}

/** The title and one-line detail of an event, per kind. */
export function describeEvent(event: EventOut): Line {
  const payload = event.payload as Payload;
  switch (event.kind) {
    case 'intake':
      return intake(payload);
    case 'outtake':
      return {
        title: KIND_LABELS.outtake,
        detail: parts(
          `Bristol ${payload['bristol']}`,
          payload['urgency'] ? 'urgent' : '',
          payload['pain'] ? `pain ${payload['pain']}/5` : '',
          ((payload['flags'] as string[] | undefined) ?? []).join(', '),
        ),
      };
    case 'symptom':
      return {
        title: humanize(String(payload['type'])),
        detail: parts(`severity ${payload['severity']}/5`, payload['body_area']),
      };
    case 'medication':
    case 'supplement':
      return {
        title: String(payload['name']),
        detail: parts(`${payload['dose']} ${payload['unit']}`, payload['reason']),
      };
    case 'sleep':
      return {
        title: KIND_LABELS.sleep,
        detail: parts(
          event.ends_at ? duration(event.occurred_at, event.ends_at) : '',
          payload['quality'] ? `quality ${payload['quality']}/5` : '',
        ),
      };
    case 'activity':
      return {
        title: KIND_LABELS.activity,
        detail: parts(
          payload['steps'] != null ? `${payload['steps']} steps` : '',
          payload['active_minutes'] != null ? `${payload['active_minutes']} active min` : '',
          payload['distance_km'] != null ? `${payload['distance_km']} km` : '',
        ),
      };
    case 'workout':
      return {
        title: String(payload['title']),
        detail: parts(
          humanize(String(payload['category'])),
          event.ends_at ? duration(event.occurred_at, event.ends_at) : '',
          payload['set_count'] != null ? `${payload['set_count']} sets` : '',
        ),
      };
    case 'measurement':
      return {
        title: humanize(String(payload['metric']).replace(/_(kg|cm|pct|bpm|ms|c|sys|dia)$/, '')),
        detail: parts(`${payload['value']} ${payload['unit'] ?? ''}`.trim()),
      };
    case 'checkin':
      return {
        title: KIND_LABELS.checkin,
        detail: parts(
          `overall ${payload['overall']}/5`,
          payload['energy'] ? `energy ${payload['energy']}/5` : '',
          payload['mood'] ? `mood ${payload['mood']}/5` : '',
          payload['stress'] ? `stress ${payload['stress']}/5` : '',
        ),
      };
    case 'note':
      return { title: KIND_LABELS.note, detail: String(payload['text']).slice(0, 120) };
  }
}

/** The name of a kind, for pickers and headings. */
export function kindLabel(kind: Kind): string {
  return KIND_LABELS[kind];
}

export const KINDS = Object.keys(KIND_LABELS) as Kind[];
```

`src/app/shared/timeline/timeline.ts`:

```ts
import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { EventOut } from '../../core/api/types';
import { clock } from '../time';
import { describeEvent } from './describe';

/** Events as time-stamped rows, one below the other; a row opens the event. */
@Component({
  selector: 'app-timeline',
  imports: [RouterLink],
  template: `
    <ol class="timeline">
      @for (event of events(); track event.id) {
        @let line = describe(event);
        <li [attr.data-kind]="event.kind" [class.retracted]="event.retracted">
          <a [routerLink]="['/event', event.chain_id]">
            <time [attr.datetime]="event.occurred_at">{{ clock(event.occurred_at) }}</time>
            <span class="body">
              <span class="title">{{ line.title }}</span>
              <span class="detail">{{ line.detail }}</span>
            </span>
            <span class="meta">
              @if (event.source !== 'app') {
                <span class="badge">{{ event.source }}</span>
              }
              @if (event.version > 1) {
                <span class="badge">edited</span>
              }
            </span>
          </a>
        </li>
      } @empty {
        <li class="empty">{{ emptyText() }}</li>
      }
    </ol>
  `,
  styles: `
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li a {
      display: grid;
      grid-template-columns: 3.25rem 1fr auto;
      gap: 0.75rem;
      align-items: baseline;
      padding: 0.6rem 0.25rem;
      border-bottom: 1px solid var(--line);
      color: inherit;
      text-decoration: none;
    }
    time {
      font-variant-numeric: tabular-nums;
      color: var(--ink-2);
    }
    .body {
      display: grid;
      min-width: 0;
    }
    .title {
      font-weight: 500;
    }
    .detail {
      color: var(--ink-2);
      font-size: 0.875rem;
    }
    .badge {
      font-size: 0.7rem;
      padding: 0.1rem 0.4rem;
      border-radius: 1rem;
      background: var(--track);
      color: var(--ink-2);
      margin-left: 0.25rem;
    }
    .retracted .body {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .empty {
      color: var(--ink-2);
      padding: 1rem 0.25rem;
    }
  `,
})
export class Timeline {
  readonly events = input.required<EventOut[]>();
  readonly emptyText = input('Nothing logged yet.');

  protected readonly clock = clock;
  protected readonly describe = describeEvent;
}
```

`src/app/shared/timeline/day-summary.ts`:

```ts
import { Component, computed, input } from '@angular/core';
import type { DaySummary } from '../../core/api/types';
import { GaugeView } from '../gauge/gauge';

/** The four gauges and the day's other totals, as one block for Today and Day. */
@Component({
  selector: 'app-day-summary',
  imports: [GaugeView],
  template: `
    <section class="gauges" aria-label="Nutrition against targets">
      @for (gauge of summary().gauges; track gauge.name) {
        <app-gauge [gauge]="gauge" />
      }
    </section>
    @if (facts().length) {
      <p class="facts">{{ facts().join(' · ') }}</p>
    }
  `,
  styles: `
    .gauges {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.5rem;
    }
    @media (min-width: 40rem) {
      .gauges {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .facts {
      color: var(--ink-2);
      font-size: 0.875rem;
    }
  `,
})
export class DaySummaryView {
  readonly summary = input.required<DaySummary>();

  protected readonly facts = computed(() => {
    const summary = this.summary();
    const symptoms = summary.symptoms.map((s) => `${s.type.replaceAll('_', ' ')} ×${s.count}`);
    return [
      summary.fluid_ml ? `${Math.round(summary.fluid_ml)} ml fluid` : '',
      summary.sleep ? `${summary.sleep.hours.toFixed(1)} h sleep` : '',
      summary.steps ? `${summary.steps.steps} steps` : '',
      summary.weight_kg !== null ? `${summary.weight_kg} kg` : '',
      summary.workouts.count
        ? `${summary.workouts.count} workout(s), ${Math.round(summary.workouts.minutes)} min`
        : '',
      summary.outtake_count ? `${summary.outtake_count} bowel movement(s)` : '',
      ...symptoms,
    ].filter(Boolean);
  });
}
```

`src/app/shared/timeline/visible.ts` (jsdom has no IntersectionObserver, so specs use
the button it is attached to):

```ts
import { Directive, ElementRef, OnDestroy, OnInit, inject, output } from '@angular/core';

/** Emits when the element scrolls into view; does nothing where IntersectionObserver is missing. */
@Directive({ selector: '[appVisible]' })
export class Visible implements OnInit, OnDestroy {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private observer: IntersectionObserver | null = null;

  readonly appVisible = output<void>();

  ngOnInit(): void {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.appVisible.emit();
        }
      },
      { rootMargin: '400px 0px' },
    );
    this.observer.observe(this.element.nativeElement);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  75 passed (75)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): gauges and the shared timeline

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Event editor and command form

**Files:**
- Create: `frontend/src/app/shared/forms/event-editor.ts`, `frontend/src/app/shared/forms/command-form.ts`
- Test: `frontend/src/app/shared/forms/event-editor.spec.ts`, `frontend/src/app/shared/forms/command-form.spec.ts`

**Interfaces:**
- Consumes: `Api`, `ApiError`, `errorText`, `toApiError`, `CommandInput`, `CommandName`,
  `EventOut`, `Kind` (Task 1); `Notices`, `fromLocalInput`, `nowIso`, `toLocalInput`
  (Task 3); `JsonSchema`, `clean`, `fieldUnder`, `formFor` (Task 4); `SchemaForm`
  (Task 5); `kindLabel` (Task 6).
- Produces:
  - `<app-event-editor [kind] [event] (saved) (cancelled)>`: without `event` it logs a new
    event with `log_events` (errors under `events.0.…`); with `event` it sends
    `correct_event` with the head's `id`, both times and the whole cleaned payload
    (errors under `payload.…`). `saved` emits the resulting `EventOut`. Command warnings
    go to `Notices`.
  - `ENDS: Record<Kind, 'forbidden' | 'optional' | 'required'>` (the journal's time rule:
    `sleep`, `activity` required; `symptom`, `workout` optional; the rest forbidden).
  - `editablePayload(event)`: the stored payload, with `items` emptied for an intake that
    was logged from a recipe (the backend takes either items or a recipe).
  - `<app-command-form [command] [initial] [fixed] [omit] [submitLabel] (done) (cancelled)>`:
    a form for any command schema; `fixed` values (e.g. `{ id }`) are hidden and sent as
    they are; `done` emits the command's `result`.

- [ ] **Step 1: Write the failing tests**

`src/app/shared/forms/event-editor.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import type { EventOut } from '../../core/api/types';
import { EventEditor, editablePayload } from './event-editor';

describe('EventEditor', () => {
  let fixture: ComponentFixture<EventEditor>;
  let element: HTMLElement;
  let saved: EventOut[];

  async function open(kind: string, existing: EventOut | null = null): Promise<void> {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(EventEditor);
    fixture.componentRef.setInput('kind', kind);
    fixture.componentRef.setInput('event', existing);
    saved = [];
    fixture.componentInstance.saved.subscribe((value) => saved.push(value));
    element = fixture.nativeElement;
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('form')).not.toBeNull();
    });
  }

  function fill(name: string, value: string): void {
    const target = element.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    target.value = value;
    target.dispatchEvent(
      new Event(
        target.tagName === 'SELECT' || target.type === 'datetime-local' ? 'change' : 'input',
      ),
    );
  }

  async function submit(): Promise<void> {
    await fixture.whenStable();
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
  }

  it('logs a new symptom with log_events', async () => {
    await open('symptom');
    fill('occurred_at', '2026-09-29T14:00');
    fill('type', 'bloated');
    fill('severity', '3');
    await submit();
    const call = await request('/api/v2/commands/log_events');
    const draft = call.request.body.events[0];
    expect(draft).toMatchObject({
      kind: 'symptom',
      payload: { type: 'bloated', severity: 3, body_area: null, note: null },
    });
    expect(draft.occurred_at).toMatch(/^2026-09-29T14:00:00[+-]\d\d:\d\d$/);
    expect(draft).not.toHaveProperty('ends_at');
    const created = event({ kind: 'symptom' });
    call.flush({ result: { events: [created] }, effects: { days: ['2026-09-29'] }, warnings: [] });
    await vi.waitFor(() => expect(saved).toEqual([created]));
  });

  it('shows a validation error at its field', async () => {
    await open('outtake');
    fill('bristol', '9');
    await submit();
    (await request('/api/v2/commands/log_events')).flush(
      {
        code: 'validation',
        message: 'Input should be less than or equal to 7',
        field: 'events.0.payload.bristol',
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[name="bristol"]')!.closest('label')!.classList).toContain(
        'invalid',
      );
    });
    expect(element.querySelector('.form-error')!.textContent).toContain('Please check the input');
    expect(saved).toEqual([]);
  });

  it('corrects an existing event with correct_event and the whole payload', async () => {
    const head = event({ id: 'head-2', kind: 'note', version: 2, payload: { text: 'old' } });
    await open('note', head);
    expect(element.querySelector('h2')!.textContent).toContain('Edit note');
    fill('text', 'new text');
    await submit();
    const call = await request('/api/v2/commands/correct_event');
    expect(call.request.body).toEqual({
      id: 'head-2',
      occurred_at: head.occurred_at,
      ends_at: null,
      payload: { text: 'new text' },
    });
    call.flush({
      result: { ...head, id: 'head-3', version: 3 },
      effects: { days: [] },
      warnings: [],
    });
    await vi.waitFor(() => expect(saved[0].id).toBe('head-3'));
  });
});

describe('editablePayload', () => {
  it('edits a recipe intake as the recipe, not its resolved items', () => {
    const stored = event({
      kind: 'intake',
      payload: { recipe_id: 'r1', portions: 2, items: [{ food_id: 'f1', grams: 100 }] },
    });
    expect(editablePayload(stored)).toEqual({ recipe_id: 'r1', portions: 2, items: [] });
  });
});
```

`src/app/shared/forms/command-form.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideFeatureTesting, request } from '../../../testing/http';
import { SCHEMAS } from '../../../testing/schemas';
import { CommandForm } from './command-form';

describe('CommandForm', () => {
  it('sends the cleaned form plus the fixed values and emits the result', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(CommandForm);
    fixture.componentRef.setInput('command', 'save_food');
    fixture.componentRef.setInput('fixed', { id: 'food-1' });
    fixture.componentRef.setInput('initial', {
      name: 'Skyr',
      brand: 'Arla',
      kind: 'food',
      per_100: { kcal: 63, protein_g: 11 },
      versions: 2,
    });
    const results: unknown[] = [];
    fixture.componentInstance.done.subscribe((result) => results.push(result));
    (await request('/api/v2/schemas')).flush(SCHEMAS);
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[name="name"]')).not.toBeNull();
    });
    expect(element.querySelector('[name="id"]')).toBeNull();
    const brand = element.querySelector<HTMLInputElement>('[name="brand"]')!;
    brand.value = '';
    brand.dispatchEvent(new Event('input'));
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const call = await request('/api/v2/commands/save_food');
    expect(call.request.body).toEqual({
      id: 'food-1',
      name: 'Skyr',
      brand: null,
      kind: 'food',
      unit_name: null,
      unit_grams: null,
      pack_grams: null,
      per_100: {
        kcal: 63,
        protein_g: 11,
        carbs_g: null,
        fat_g: null,
        fiber_g: null,
        sugar_g: null,
        salt_g: null,
      },
    });
    call.flush({ result: { id: 'food-1' }, effects: { days: [] }, warnings: [] });
    await vi.waitFor(() => expect(results).toEqual([{ id: 'food-1' }]));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./event-editor"` and `"./command-form"`.

- [ ] **Step 3: Implement**

`src/app/shared/forms/event-editor.ts`:

```ts
import {
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  resource,
  signal,
} from '@angular/core';
import { Api } from '../../core/api/api';
import { ApiError, errorText, toApiError } from '../../core/api/errors';
import type { CommandInput, EventOut, Kind } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { kindLabel } from '../timeline/describe';
import { fromLocalInput, nowIso, toLocalInput } from '../time';
import { JsonSchema, clean, fieldUnder, formFor } from './schema';
import { SchemaForm } from './schema-form';

type Draft = CommandInput<'log_events'>['events'][number];

/** Whether a kind has an end time; mirrors the journal's time rule per kind. */
export const ENDS: Record<Kind, 'forbidden' | 'optional' | 'required'> = {
  intake: 'forbidden',
  outtake: 'forbidden',
  symptom: 'optional',
  medication: 'forbidden',
  supplement: 'forbidden',
  sleep: 'required',
  activity: 'required',
  workout: 'optional',
  measurement: 'forbidden',
  checkin: 'forbidden',
  note: 'forbidden',
};

/** A stored payload as its input form: an intake from a recipe is edited as the recipe. */
export function editablePayload(event: EventOut): Record<string, unknown> {
  const payload = { ...(event.payload as Record<string, unknown>) };
  if (event.kind === 'intake' && payload['recipe_id']) {
    payload['items'] = [];
  }
  return payload;
}

/** Create (log_events) or correct (correct_event) one event with a generated payload form. */
@Component({
  selector: 'app-event-editor',
  imports: [SchemaForm],
  template: `
    @if (form(); as field) {
      <form (submit)="$event.preventDefault(); save()">
        <h2>{{ event() ? 'Edit' : 'Log' }} {{ title() }}</h2>
        <label [class.invalid]="timeError() === 'occurred_at'">
          <span class="label">{{ ends() === 'forbidden' ? 'Time' : 'Start' }}</span>
          <input
            type="datetime-local"
            name="occurred_at"
            required
            [value]="local(occurredAt())"
            (change)="occurredAt.set(iso($any($event.target).value))"
          />
        </label>
        @if (ends() !== 'forbidden') {
          <label [class.invalid]="timeError() === 'ends_at'">
            <span class="label">End</span>
            <input
              type="datetime-local"
              name="ends_at"
              [required]="ends() === 'required'"
              [value]="endsAt() ? local(endsAt()!) : ''"
              (change)="
                endsAt.set($any($event.target).value ? iso($any($event.target).value) : null)
              "
            />
          </label>
        }
        <app-schema-form
          [field]="field"
          [(value)]="payload"
          [errorPath]="payloadError()"
          [errorMessage]="error()?.message ?? ''"
        />
        @if (error(); as failure) {
          <p class="form-error">{{ text(failure) }}</p>
        }
        <div class="actions">
          <button type="button" class="secondary" (click)="cancelled.emit()">Cancel</button>
          <button type="submit" [disabled]="busy()">Save</button>
        </div>
      </form>
    } @else if (schemas.error()) {
      <p class="form-error">{{ text(schemas.error()) }}</p>
    }
  `,
})
export class EventEditor implements OnInit {
  private readonly api = inject(Api);
  private readonly notices = inject(Notices);

  readonly kind = input.required<Kind>();
  readonly event = input<EventOut | null>(null);
  readonly saved = output<EventOut>();
  readonly cancelled = output<void>();

  protected readonly schemas = resource({ loader: () => this.api.schemas() });
  protected readonly form = computed(() => {
    const payloads = this.schemas.value()?.payloads;
    return payloads ? formFor(payloads[this.kind()] as JsonSchema) : null;
  });
  protected readonly title = computed(() => kindLabel(this.kind()).toLowerCase());
  protected readonly ends = computed(() => ENDS[this.kind()]);
  protected readonly payload = signal<Record<string, unknown>>({});
  protected readonly occurredAt = signal(nowIso());
  protected readonly endsAt = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly prefix = computed(() => (this.event() ? '' : 'events.0.'));
  protected readonly payloadError = computed(() =>
    fieldUnder(this.error()?.field, `${this.prefix()}payload`),
  );
  protected readonly timeError = computed(() =>
    fieldUnder(this.error()?.field, this.prefix().slice(0, -1)),
  );
  protected readonly local = toLocalInput;
  protected readonly iso = fromLocalInput;
  protected readonly text = errorText;

  ngOnInit(): void {
    const event = this.event();
    if (event) {
      this.payload.set(editablePayload(event));
      this.occurredAt.set(event.occurred_at);
      this.endsAt.set(event.ends_at);
    }
  }

  protected async save(): Promise<void> {
    const field = this.form();
    if (!field) {
      return;
    }
    const payload = clean(field, this.payload()) as Record<string, unknown>;
    const endsAt = this.ends() === 'forbidden' ? null : this.endsAt();
    this.busy.set(true);
    this.error.set(null);
    try {
      const current = this.event();
      const response = current
        ? await this.api.command('correct_event', {
            id: current.id,
            occurred_at: this.occurredAt(),
            ends_at: endsAt,
            payload,
          })
        : await this.api.command('log_events', {
            events: [
              {
                kind: this.kind(),
                occurred_at: this.occurredAt(),
                ...(endsAt ? { ends_at: endsAt } : {}),
                payload,
              } as Draft,
            ],
          });
      this.notices.warnings(response.warnings);
      this.saved.emit('events' in response.result ? response.result.events[0] : response.result);
    } catch (error) {
      this.error.set(toApiError(error));
    } finally {
      this.busy.set(false);
    }
  }
}
```

`src/app/shared/forms/command-form.ts`:

```ts
import {
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  resource,
  signal,
} from '@angular/core';
import { Api } from '../../core/api/api';
import { ApiError, errorText, toApiError } from '../../core/api/errors';
import type { CommandInput, CommandName } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { JsonSchema, clean, formFor } from './schema';
import { SchemaForm } from './schema-form';

/** A form generated from a command's schema; `fixed` values (such as an id) are sent unchanged. */
@Component({
  selector: 'app-command-form',
  imports: [SchemaForm],
  template: `
    @if (form(); as field) {
      <form (submit)="$event.preventDefault(); save()">
        <app-schema-form
          [field]="field"
          [(value)]="value"
          [errorPath]="error()?.field ?? null"
          [errorMessage]="error()?.message ?? ''"
        />
        @if (error(); as failure) {
          <p class="form-error">{{ text(failure) }}</p>
        }
        <div class="actions">
          <button type="button" class="secondary" (click)="cancelled.emit()">Cancel</button>
          <button type="submit" [disabled]="busy()">{{ submitLabel() }}</button>
        </div>
      </form>
    } @else if (schemas.error()) {
      <p class="form-error">{{ text(schemas.error()) }}</p>
    }
  `,
})
export class CommandForm implements OnInit {
  private readonly api = inject(Api);
  private readonly notices = inject(Notices);

  readonly command = input.required<CommandName>();
  readonly initial = input<Record<string, unknown>>({});
  readonly fixed = input<Record<string, unknown>>({});
  readonly omit = input<string[]>([]);
  readonly submitLabel = input('Save');
  readonly done = output<unknown>();
  readonly cancelled = output<void>();

  protected readonly schemas = resource({ loader: () => this.api.schemas() });
  protected readonly form = computed(() => {
    const schema = this.schemas.value()?.commands[this.command()] as JsonSchema | undefined;
    return schema ? formFor(schema, [...this.omit(), ...Object.keys(this.fixed())]) : null;
  });
  protected readonly value = signal<Record<string, unknown>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly text = errorText;

  ngOnInit(): void {
    this.value.set({ ...this.initial() });
  }

  protected async save(): Promise<void> {
    const field = this.form();
    if (!field) {
      return;
    }
    const body = { ...(clean(field, this.value()) as object), ...this.fixed() };
    this.busy.set(true);
    this.error.set(null);
    try {
      const response = await this.api.command(this.command(), body as CommandInput<CommandName>);
      this.notices.warnings(response.warnings);
      this.done.emit(response.result);
    } catch (error) {
      this.error.set(toApiError(error));
    } finally {
      this.busy.set(false);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  80 passed (80)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): event editor (log and correct) and generic command form

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---


### Task 8: Today and Day

**Files:**
- Create: `frontend/src/app/features/today/today.ts`, `frontend/src/app/features/day/day.ts`, `frontend/src/testing/views.ts`
- Modify: `frontend/src/app/app.routes.ts`
- Test: `frontend/src/app/features/today/today.spec.ts`, `frontend/src/app/features/day/day.spec.ts`

**Interfaces:**
- Consumes: `Api`, `reloadAfterCommands`, `errorText` (Task 1); `addDays`, `dayLabel`
  (Task 3); `DaySummaryView`, `Timeline`, `KINDS`, `kindLabel` (Task 6).
- Produces: `TodayPage` (`/today`): the "+" button toggles a kind picker whose links go to
  `/log/<kind>` (Task 10); the four gauges and totals; weight and 14-day trend; the
  context warnings; today's timeline; symptoms of the last 3 days. `DayPage`
  (`/day/:date`, input `date`): ‹ › links to the neighbouring days, gauges, totals,
  timeline. Spec helpers `summary(day?)`, `dayView(timeline?, day?)`, `context(timeline?)`.

- [ ] **Step 1: Write the failing tests**

`src/testing/views.ts`:

```ts
import type { ContextOut, DaySummary, DayView, EventOut } from '../app/core/api/types';

const zero = {
  kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
  sugar_g: 0,
  salt_g: 0,
  fluid_ml: 0,
};

/** A day summary with four gauges and nothing else logged. */
export function summary(day = '2026-09-29'): DaySummary {
  return {
    day,
    nutrients: zero,
    fluid_ml: 0,
    sleep: null,
    steps: null,
    weight_kg: null,
    workouts: { count: 0, minutes: 0 },
    symptoms: [],
    outtake_count: 0,
    energy: { bmr: 1780, baseline: 2136, steps_kcal: 210, workouts_kcal: 0, maintenance: 2346 },
    targets: {
      kcal: 1846,
      protein_g: 147,
      carbs_g: 183,
      fat_g: 58,
      adjustment_kcal: -500,
      missing: [],
      warnings: [],
    },
    gauges: [
      { name: 'kcal', value: 900, target: 1846, ratio: 0.49 },
      { name: 'protein', value: 60, target: 147, ratio: 0.41 },
      { name: 'carbs', value: 100, target: 183, ratio: 0.55 },
      { name: 'fat', value: 30, target: 58, ratio: 0.52 },
    ],
  };
}

export function dayView(timeline: EventOut[] = [], day = '2026-09-29'): DayView {
  return { summary: summary(day), timeline };
}

export function context(timeline: EventOut[] = []): ContextOut {
  return {
    today: '2026-09-29',
    day: dayView(timeline),
    weight: { latest_kg: 81.4, latest_day: '2026-09-29', trend_kg_per_week: -0.3 },
    recent_symptoms: [],
    integrations: [],
    warnings: ['no weight for 7 days'],
  };
}
```

`src/app/features/today/today.spec.ts` (also proves the view stays on screen while it
reloads after a command):

```ts
import { TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request } from '../../../testing/http';
import { context } from '../../../testing/views';
import { Api } from '../../core/api/api';
import { TodayPage } from './today';

describe('TodayPage', () => {
  it('shows the four gauges, warnings and the timeline, and reloads after a command', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/today')).flush(context([event()]));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('app-gauge')).toHaveLength(4);
    });
    expect(element.querySelector('.warnings')!.textContent).toContain('no weight for 7 days');
    expect(element.querySelectorAll('app-timeline li')).toHaveLength(1);
    expect(element.textContent).toContain('Weight 81.4 kg');

    TestBed.inject(Api).revision.update((value) => value + 1);
    const reload = await request('/api/v2/views/today');
    expect(element.querySelectorAll('app-gauge')).toHaveLength(4);
    reload.flush(context([]));
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('app-timeline li')).toHaveLength(1);
      expect(element.textContent).toContain('Nothing logged yet.');
    });
  });

  it('opens the kind picker from the + button', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(TodayPage);
    const element: HTMLElement = fixture.nativeElement;
    (await request('/api/v2/views/today')).flush(context());
    await fixture.whenStable();
    element.querySelector<HTMLButtonElement>('button.add')!.click();
    await fixture.whenStable();
    const links = [...element.querySelectorAll('.kind-picker a')];
    expect(links).toHaveLength(11);
    expect(links[0].getAttribute('href')).toBe('/log/intake');
  });
});
```

`src/app/features/day/day.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideFeatureTesting, request } from '../../../testing/http';
import { dayView } from '../../../testing/views';
import { DayPage } from './day';

describe('DayPage', () => {
  it('loads the date from the route and links the neighbouring days', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(DayPage);
    fixture.componentRef.setInput('date', '2026-09-01');
    const call = await request('/api/v2/views/day');
    expect(call.request.params.get('date')).toBe('2026-09-01');
    call.flush(dayView([], '2026-09-01'));
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelectorAll('app-gauge')).toHaveLength(4);
    const links = [...element.querySelectorAll('.page-head a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/day/2026-08-31', '/day/2026-09-02']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./today"` and `"./day"`.

- [ ] **Step 3: Implement**

`src/app/features/today/today.ts`:

```ts
import { Component, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import { DaySummaryView } from '../../shared/timeline/day-summary';
import { KINDS, kindLabel } from '../../shared/timeline/describe';
import { Timeline } from '../../shared/timeline/timeline';

/** Today: the four gauges, warnings, the day's timeline and a "+" to log anything. */
@Component({
  selector: 'app-today',
  imports: [RouterLink, DaySummaryView, Timeline],
  template: `
    <header class="page-head">
      <h1>Today</h1>
      <button
        type="button"
        class="add"
        aria-label="Log something"
        [attr.aria-expanded]="picking()"
        (click)="picking.set(!picking())"
      >
        +
      </button>
    </header>
    @if (picking()) {
      <nav class="kind-picker" aria-label="Log">
        @for (kind of kinds; track kind) {
          <a [routerLink]="['/log', kind]">{{ label(kind) }}</a>
        }
      </nav>
    }
    @if (context.value(); as context) {
      <app-day-summary [summary]="context.day.summary" />
      @if (context.weight.latest_kg !== null) {
        <p class="muted">
          Weight {{ context.weight.latest_kg }} kg
          @if (context.weight.trend_kg_per_week !== null) {
            · {{ context.weight.trend_kg_per_week > 0 ? '+' : ''
            }}{{ context.weight.trend_kg_per_week }} kg/week
          }
        </p>
      }
      @if (context.warnings.length) {
        <ul class="warnings">
          @for (warning of context.warnings; track warning) {
            <li>{{ warning }}</li>
          }
        </ul>
      }
      <app-timeline [events]="context.day.timeline" />
      @if (context.recent_symptoms.length) {
        <h2>Symptoms, last 3 days</h2>
        <app-timeline [events]="context.recent_symptoms" />
      }
    } @else if (context.error()) {
      <p class="form-error">{{ text(context.error()) }}</p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
})
export class TodayPage {
  private readonly api = inject(Api);

  protected readonly kinds = KINDS;
  protected readonly label = kindLabel;
  protected readonly text = errorText;
  protected readonly picking = signal(false);
  protected readonly context = resource({ loader: () => this.api.view('today') });

  constructor() {
    reloadAfterCommands(this.context);
  }
}
```

`src/app/features/day/day.ts`:

```ts
import { Component, computed, inject, input, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import { DaySummaryView } from '../../shared/timeline/day-summary';
import { Timeline } from '../../shared/timeline/timeline';
import { addDays, dayLabel } from '../../shared/time';

/** One date: gauges, totals and timeline, with steps to the day before and after. */
@Component({
  selector: 'app-day',
  imports: [RouterLink, DaySummaryView, Timeline],
  template: `
    <header class="page-head">
      <a [routerLink]="['/day', previous()]" aria-label="Day before">‹</a>
      <h1>{{ title() }}</h1>
      <a [routerLink]="['/day', next()]" aria-label="Day after">›</a>
    </header>
    @if (day.value(); as view) {
      <app-day-summary [summary]="view.summary" />
      <app-timeline [events]="view.timeline" />
    } @else if (day.error()) {
      <p class="form-error">{{ text(day.error()) }}</p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
})
export class DayPage {
  private readonly api = inject(Api);

  readonly date = input.required<string>();

  protected readonly title = computed(() => dayLabel(this.date()));
  protected readonly previous = computed(() => addDays(this.date(), -1));
  protected readonly next = computed(() => addDays(this.date(), 1));
  protected readonly text = errorText;
  protected readonly day = resource({
    params: () => ({ date: this.date() }),
    loader: ({ params }) => this.api.view('day', params),
  });

  constructor() {
    reloadAfterCommands(this.day);
  }
}
```

In `src/app/app.routes.ts`, insert before `{ path: '**', redirectTo: 'today' }`:

```ts
      {
        path: 'today',
        loadComponent: () => import('./features/today/today').then((m) => m.TodayPage),
      },
      {
        path: 'day/:date',
        loadComponent: () => import('./features/day/day').then((m) => m.DayPage),
      },
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  83 passed (83)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): Today with the four gauges, and the Day view

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The continuous Diary

**Files:**
- Create: `frontend/src/app/features/diary/diary.ts`
- Modify: `frontend/src/app/app.routes.ts`
- Test: `frontend/src/app/features/diary/diary.spec.ts`

**Interfaces:**
- Consumes: `Api`, `errorText`, `DiaryDay`, `Kind` (Task 1); `dayLabel` (Task 3);
  `Timeline`, `Visible`, `KINDS`, `kindLabel` (Task 6).
- Produces: `DiaryPage` (`/diary`): kind filter chips; one section per day (sticky day
  heading linking to `/day/<date>`, then that day's timeline) newest day first; pages of
  7 days through `next_cursor`; a "Load older days" button that also loads when it scrolls
  into view; "No older entries." at the end. A filter change or any command restarts from
  the newest day; a page that arrives after a restart is dropped.

- [ ] **Step 1: Write the failing test**

`src/app/features/diary/diary.spec.ts` (spec §11: diary cursor paging):

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request } from '../../../testing/http';
import { DiaryPage } from './diary';

describe('DiaryPage', () => {
  let fixture: ComponentFixture<DiaryPage>;
  let element: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(DiaryPage);
    element = fixture.nativeElement;
  });

  function button(text: string): HTMLButtonElement {
    return [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  }

  it('pages through older days with the cursor and appends them', async () => {
    const first = await request('/api/v2/views/diary');
    expect(first.request.params.keys()).toEqual(['days']);
    expect(first.request.params.get('days')).toBe('7');
    first.flush({
      days: [
        { day: '2026-09-29', events: [event({ id: 'a' }), event({ id: 'b' })] },
        { day: '2026-09-27', events: [event({ id: 'c' })] },
      ],
      next_cursor: 'cursor-1',
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('.diary-day')).toHaveLength(2);
    });
    expect(element.querySelectorAll('app-timeline li')).toHaveLength(3);

    button('Load older days').click();
    const second = await request('/api/v2/views/diary');
    expect(second.request.params.get('cursor')).toBe('cursor-1');
    second.flush({
      days: [{ day: '2026-09-20', events: [event({ id: 'd' })] }],
      next_cursor: null,
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('.diary-day')).toHaveLength(3);
    });
    expect(element.textContent).toContain('No older entries.');
    expect(button('Load older days')).toBeUndefined();
  });

  it('starts over with a kind filter', async () => {
    (await request('/api/v2/views/diary')).flush({ days: [], next_cursor: null });
    await fixture.whenStable();
    button('Symptom').click();
    const filtered = await request('/api/v2/views/diary');
    expect(filtered.request.params.getAll('kinds')).toEqual(['symptom']);
    expect(filtered.request.params.has('cursor')).toBe(false);
    filtered.flush({ days: [], next_cursor: null });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -- --include src/app/features/diary/diary.spec.ts`
Expected: the build fails with `Could not resolve "./diary"`.

- [ ] **Step 3: Implement**

`src/app/features/diary/diary.ts`:

```ts
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { DiaryDay, Kind } from '../../core/api/types';
import { KINDS, kindLabel } from '../../shared/timeline/describe';
import { Timeline } from '../../shared/timeline/timeline';
import { Visible } from '../../shared/timeline/visible';
import { dayLabel } from '../../shared/time';

const PAGE_DAYS = 7;

/** The continuous diary: newest day first, every entry a time-stamped row, older days on scroll. */
@Component({
  selector: 'app-diary',
  imports: [RouterLink, Timeline, Visible],
  template: `
    <header class="page-head"><h1>Diary</h1></header>
    <nav class="chips" aria-label="Filter by kind">
      @for (kind of kinds; track kind) {
        <button type="button" [class.on]="filter().includes(kind)" (click)="toggle(kind)">
          {{ label(kind) }}
        </button>
      }
    </nav>
    @for (day of days(); track day.day) {
      <section class="diary-day">
        <h2 class="day-head">
          <a [routerLink]="['/day', day.day]">{{ dayTitle(day.day) }}</a>
        </h2>
        <app-timeline [events]="day.events" />
      </section>
    }
    @if (error()) {
      <p class="form-error">{{ error() }}</p>
    }
    @if (done()) {
      <p class="muted end">{{ days().length ? 'No older entries.' : 'Nothing logged yet.' }}</p>
    } @else {
      <button
        type="button"
        class="secondary more"
        [disabled]="loading()"
        (appVisible)="more()"
        (click)="more()"
      >
        {{ loading() ? 'Loading…' : 'Load older days' }}
      </button>
    }
  `,
  styles: `
    .day-head {
      position: sticky;
      top: 0;
      margin: 0;
      padding: 0.75rem 0 0.25rem;
      background: var(--page);
      font-size: 0.95rem;
    }
    .day-head a {
      color: var(--ink);
      text-decoration: none;
    }
    .more,
    .end {
      display: block;
      margin: 1.5rem auto;
    }
  `,
})
export class DiaryPage {
  private readonly api = inject(Api);
  private generation = 0;

  protected readonly kinds = KINDS;
  protected readonly label = kindLabel;
  protected readonly dayTitle = (day: string) => dayLabel(day);
  protected readonly filter = signal<Kind[]>([]);
  protected readonly days = signal<DiaryDay[]>([]);
  protected readonly cursor = signal<string | null>(null);
  protected readonly done = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.api.revision();
      this.filter();
      untracked(() => this.restart());
    });
  }

  protected toggle(kind: Kind): void {
    this.filter.update((kinds) =>
      kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind],
    );
  }

  protected async more(): Promise<void> {
    if (this.loading() || this.done()) {
      return;
    }
    const generation = this.generation;
    this.loading.set(true);
    this.error.set(null);
    try {
      const kinds = this.filter();
      const page = await this.api.view('diary', {
        cursor: this.cursor(),
        days: PAGE_DAYS,
        kinds: kinds.length ? kinds : null,
      });
      if (generation !== this.generation) {
        return;
      }
      this.days.update((days) => [...days, ...page.days]);
      this.cursor.set(page.next_cursor);
      this.done.set(page.next_cursor === null);
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      if (generation === this.generation) {
        this.loading.set(false);
      }
    }
  }

  private restart(): void {
    this.generation++;
    this.days.set([]);
    this.cursor.set(null);
    this.done.set(false);
    this.loading.set(false);
    void this.more();
  }
}
```

In `src/app/app.routes.ts`, insert before `{ path: '**', redirectTo: 'today' }`:

```ts
      {
        path: 'diary',
        loadComponent: () => import('./features/diary/diary').then((m) => m.DiaryPage),
      },
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  85 passed (85)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): continuous diary with cursor paging and kind filter

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Event detail and logging a new entry

**Files:**
- Create: `frontend/src/app/features/event/history.ts`, `frontend/src/app/features/event/link-row.ts`, `frontend/src/app/features/event/event.ts`, `frontend/src/app/features/event/log.ts`
- Modify: `frontend/src/app/app.routes.ts`
- Test: `frontend/src/app/features/event/history.spec.ts`, `frontend/src/app/features/event/event.spec.ts`, `frontend/src/app/features/event/log.spec.ts`

**Interfaces:**
- Consumes: `Api`, `reloadAfterCommands`, `errorText`, `EventOut`, `LinkOut`, `Relation`
  (Task 1); `Notices`, `addDays`, `clock`, `dayLabel`, `localDay` (Task 3); `humanize`
  (Task 4); `describeEvent`, `kindLabel`, `KINDS` (Task 6); `EventEditor` (Task 7).
- Produces:
  - `versionLine(version, today?)` → "logged by app at 08:15" (version 1) or "corrected by
    claude at 14:02" (later), with the day added when it is not today.
  - `payloadRows(payload)` → `[label, value][]` of the set values (items, nutrients,
    exercises and recipe_version_id are shown elsewhere or not at all).
  - `<app-link-row [link] (unlink)>`: "Suspected cause:" (outgoing) or "Suspected cause
    of:" (incoming), the other event's title and time (loaded by chain), an Unlink button.
  - `EventPage` (`/event/:chain`, input `chain`): the head's title, time, detail, intake
    items, payload rows; links; history newest first; actions Edit (the event editor with
    the head), Link (relation select and the entries of this day and the day before →
    `link_events` from this chain), Retract (optional reason → `retract_event` with the
    head's id). Unlink sends the link's stored direction.
  - `LogPage` (`/log/:kind`, input `kind`): the event editor for a new entry; back to the
    previous page after save or cancel; an unknown kind is refused.

- [ ] **Step 1: Write the failing tests**

`src/app/features/event/history.spec.ts` (time-zone independent):

```ts
import { event } from '../../../testing/events';
import { addDays, clock, dayLabel, localDay } from '../../shared/time';
import { payloadRows, versionLine } from './history';

describe('versionLine', () => {
  it('says who logged and who corrected, and when', () => {
    const first = event({ version: 1, source: 'app', recorded_at: '2026-09-29T06:15:00Z' });
    const second = event({ version: 2, source: 'claude', recorded_at: '2026-09-29T12:02:00Z' });
    const day = localDay(new Date(second.recorded_at));
    expect(versionLine(first, localDay(new Date(first.recorded_at)))).toBe(
      `logged by app at ${clock(first.recorded_at)}`,
    );
    expect(versionLine(second, day)).toBe(`corrected by claude at ${clock(second.recorded_at)}`);
    expect(versionLine(second, addDays(day, 7))).toBe(
      `corrected by claude at ${clock(second.recorded_at)}, ${dayLabel(day, addDays(day, 7))}`,
    );
  });
});

describe('payloadRows', () => {
  it('lists the set values and sums up nested ones', () => {
    expect(
      payloadRows({
        bristol: 4,
        urgency: null,
        flags: ['mucus', 'blood'],
        note: '',
        stages: { deep_min: 90 },
      }),
    ).toEqual([
      ['bristol', '4'],
      ['flags', 'mucus, blood'],
      ['stages', 'deep min 90'],
    ]);
  });
});
```

`src/app/features/event/event.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request, requests } from '../../../testing/http';
import { dayView } from '../../../testing/views';
import type { EventHistory } from '../../core/api/types';
import { EventPage } from './event';

const history: EventHistory = {
  chain_id: 'c-1',
  kind: 'symptom',
  versions: [
    event({ id: 'v1', kind: 'symptom', version: 1, payload: { type: 'bloated', severity: 2 } }),
    event({
      id: 'v2',
      kind: 'symptom',
      version: 2,
      source: 'claude',
      payload: { type: 'bloated', severity: 4 },
      recorded_at: '2026-09-29T12:02:00Z',
    }),
  ],
  links: [{ chain_id: 'c-breakfast', relation: 'suspected_cause', direction: 'outgoing' }],
};

describe('EventPage', () => {
  let fixture: ComponentFixture<EventPage>;
  let element: HTMLElement;

  async function open(): Promise<void> {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    fixture = TestBed.createComponent(EventPage);
    fixture.componentRef.setInput('chain', 'c-1');
    element = fixture.nativeElement;
    (await request('/api/v2/views/event')).flush(history);
    const other = await request(
      (r) => r.url === '/api/v2/views/event' && r.params.get('chain_id') === 'c-breakfast',
    );
    other.flush({
      chain_id: 'c-breakfast',
      kind: 'intake',
      versions: [
        event({
          kind: 'intake',
          chain_id: 'c-breakfast',
          payload: { slot: 'breakfast', items: [] },
        }),
      ],
      links: [],
    });
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('app-link-row a')!.textContent).toContain('Breakfast');
    });
  }

  function button(text: string): HTMLButtonElement {
    return [...element.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
  }

  it('shows the head, its links and the history newest first', async () => {
    await open();
    expect(element.querySelector('h1')!.textContent).toBe('Bloated');
    expect(element.textContent).toContain('severity 4/5');
    expect(element.querySelector('app-link-row')!.textContent).toContain('Suspected cause:');
    const versions = [...element.querySelectorAll('.history li')].map((li) => li.textContent);
    expect(versions[0]).toMatch(/^v2 · corrected by claude at/);
    expect(versions[1]).toMatch(/^v1 · logged by app at/);
  });

  it('retracts the head with a reason', async () => {
    await open();
    button('Retract').click();
    await fixture.whenStable();
    const reason = element.querySelector<HTMLInputElement>('[name="reason"]')!;
    reason.value = 'logged twice';
    reason.dispatchEvent(new Event('input'));
    element.querySelector('form')!.dispatchEvent(new Event('submit'));
    const call = await request('/api/v2/commands/retract_event');
    expect(call.request.body).toEqual({ id: 'v2', reason: 'logged twice' });
  });

  it('links to an entry of the same day or the day before', async () => {
    await open();
    button('Link').click();
    const [before, same] = await requests('/api/v2/views/day', 2);
    expect(before.request.params.get('date')).toBe('2026-09-28');
    before.flush(dayView([], '2026-09-28'));
    same.flush(
      dayView([event({ id: 'lunch', chain_id: 'c-lunch', kind: 'note', payload: { text: 'x' } })]),
    );
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('.candidates button')).toHaveLength(1);
    });
    element.querySelector<HTMLButtonElement>('.candidates button')!.click();
    const call = await request('/api/v2/commands/link_events');
    expect(call.request.body).toEqual({
      from_chain: 'c-1',
      to_chain: 'c-lunch',
      relation: 'suspected_cause',
    });
  });

  it('unlinks in the stored direction', async () => {
    await open();
    button('Unlink').click();
    const call = await request('/api/v2/commands/unlink_events');
    expect(call.request.body).toEqual({
      from_chain: 'c-1',
      to_chain: 'c-breakfast',
      relation: 'suspected_cause',
    });
  });
});
```

`src/app/features/event/log.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideFeatureTesting } from '../../../testing/http';
import { LogPage } from './log';

describe('LogPage', () => {
  it('opens the editor for a known kind and refuses an unknown one', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(LogPage);
    fixture.componentRef.setInput('kind', 'sleep');
    TestBed.tick();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('app-event-editor')).not.toBeNull();
    fixture.componentRef.setInput('kind', 'dance');
    TestBed.tick();
    expect(element.textContent).toContain('Unknown kind "dance".');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./history"`, `"./event"` and `"./log"`.

- [ ] **Step 3: Implement**

`src/app/features/event/history.ts`:

```ts
import type { EventOut } from '../../core/api/types';
import { clock, dayLabel, localDay } from '../../shared/time';

/** "logged by app at 08:15" for the first version, "corrected by claude at 14:02" after. */
export function versionLine(version: EventOut, today = localDay()): string {
  const verb = version.version === 1 ? 'logged' : 'corrected';
  const day = localDay(new Date(version.recorded_at));
  const when =
    day === today
      ? clock(version.recorded_at)
      : `${clock(version.recorded_at)}, ${dayLabel(day, today)}`;
  return `${verb} by ${version.source} at ${when}`;
}

/** Payload values worth listing, as label/value pairs; lists and nested objects are summed up. */
export function payloadRows(payload: Record<string, unknown>): [string, string][] {
  const hidden = new Set(['items', 'nutrients', 'recipe_version_id', 'exercises']);
  return Object.entries(payload)
    .filter(
      ([key, value]) =>
        !hidden.has(key) &&
        value !== null &&
        value !== '' &&
        !(Array.isArray(value) && !value.length),
    )
    .map(([key, value]) => [
      key.replaceAll('_', ' '),
      Array.isArray(value)
        ? value.join(', ')
        : typeof value === 'object'
          ? Object.entries(value as Record<string, unknown>)
              .map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`)
              .join(', ')
          : String(value),
    ]);
}
```

`src/app/features/event/link-row.ts`:

```ts
import { Component, computed, inject, input, output, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api/api';
import type { LinkOut } from '../../core/api/types';
import { humanize } from '../../shared/forms/schema';
import { describeEvent } from '../../shared/timeline/describe';
import { clock, dayLabel } from '../../shared/time';

/** One link of an event: the relation, the other event (loaded by chain) and an unlink button. */
@Component({
  selector: 'app-link-row',
  imports: [RouterLink],
  template: `
    <span class="relation">{{ relation() }}</span>
    <a [routerLink]="['/event', link().chain_id]">{{ other() }}</a>
    <button type="button" class="link" (click)="unlink.emit(link())">Unlink</button>
  `,
})
export class LinkRow {
  private readonly api = inject(Api);

  readonly link = input.required<LinkOut>();
  readonly unlink = output<LinkOut>();

  protected readonly target = resource({
    params: () => ({ chain_id: this.link().chain_id }),
    loader: ({ params }) => this.api.view('event', params),
  });
  protected readonly relation = computed(() => {
    const { relation, direction } = this.link();
    return direction === 'outgoing' ? `${humanize(relation)}:` : `${humanize(relation)} of:`;
  });
  protected readonly other = computed(() => {
    const head = this.target.value()?.versions.at(-1);
    if (!head) {
      return '…';
    }
    return `${describeEvent(head).title} (${dayLabel(head.local_day)} ${clock(head.occurred_at)})`;
  });
}
```

`src/app/features/event/event.ts`:

```ts
import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { EventOut, LinkOut, Relation } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { EventEditor } from '../../shared/forms/event-editor';
import { humanize } from '../../shared/forms/schema';
import { describeEvent, kindLabel } from '../../shared/timeline/describe';
import { addDays, clock, dayLabel } from '../../shared/time';
import { payloadRows, versionLine } from './history';
import { LinkRow } from './link-row';

const RELATIONS: Relation[] = ['suspected_cause', 'part_of', 'follows'];

/** One event: its payload, links and version history, with edit, retract and link. */
@Component({
  selector: 'app-event',
  imports: [EventEditor, LinkRow],
  template: `
    @if (history.value(); as chain) {
      @let current = head()!;
      @if (mode() === 'edit') {
        <app-event-editor
          [kind]="chain.kind"
          [event]="current"
          (saved)="mode.set('view')"
          (cancelled)="mode.set('view')"
        />
      } @else {
        <header class="page-head">
          <h1>{{ line().title }}</h1>
        </header>
        <p class="muted">
          {{ kind() }} · {{ dayLabel(current.local_day) }} {{ clock(current.occurred_at) }}
          @if (current.ends_at) {
            – {{ clock(current.ends_at) }}
          }
        </p>
        @if (current.retracted) {
          <p class="retracted-note">Retracted: this no longer counts.</p>
        }
        <p>{{ line().detail }}</p>
        @if (items().length) {
          <table class="items">
            @for (item of items(); track $index) {
              <tr>
                <td>{{ item.name }}</td>
                <td class="num">{{ item.grams }} g</td>
                <td class="num">{{ round(item.nutrients?.kcal) }} kcal</td>
              </tr>
            }
          </table>
        }
        <dl class="rows">
          @for (row of rows(); track row[0]) {
            <dt>{{ row[0] }}</dt>
            <dd>{{ row[1] }}</dd>
          }
        </dl>

        <h2>Links</h2>
        @for (link of chain.links; track link.chain_id + link.relation + link.direction) {
          <app-link-row [link]="link" (unlink)="unlink($event)" />
        } @empty {
          <p class="muted">No links.</p>
        }

        <h2>History</h2>
        <ol class="history">
          @for (version of versionsNewestFirst(); track version.id) {
            <li>v{{ version.version }} · {{ versionText(version) }}</li>
          }
        </ol>

        @if (!current.retracted) {
          @switch (mode()) {
            @case ('retract') {
              <form class="inline" (submit)="$event.preventDefault(); retract()">
                <label>
                  <span class="label">Reason (optional)</span>
                  <input
                    name="reason"
                    [value]="reason()"
                    (input)="reason.set($any($event.target).value)"
                  />
                </label>
                <div class="actions">
                  <button type="button" class="secondary" (click)="mode.set('view')">Cancel</button>
                  <button type="submit" class="danger">Retract</button>
                </div>
              </form>
            }
            @case ('link') {
              <section class="inline">
                <label>
                  <span class="label">Relation</span>
                  <select name="relation" (change)="relation.set($any($event.target).value)">
                    @for (option of relations; track option) {
                      <option [value]="option" [selected]="relation() === option">
                        {{ words(option) }}
                      </option>
                    }
                  </select>
                </label>
                <p class="muted">Link to an entry from this day or the day before:</p>
                <ul class="candidates">
                  @for (candidate of candidates.value() ?? []; track candidate.id) {
                    <li>
                      <button type="button" (click)="link(candidate)">
                        {{ clock(candidate.occurred_at) }} {{ titleOf(candidate) }}
                      </button>
                    </li>
                  }
                </ul>
                <button type="button" class="secondary" (click)="mode.set('view')">Cancel</button>
              </section>
            }
            @default {
              <div class="actions">
                <button type="button" (click)="mode.set('edit')">Edit</button>
                <button type="button" class="secondary" (click)="mode.set('link')">Link</button>
                <button type="button" class="danger" (click)="mode.set('retract')">Retract</button>
              </div>
            }
          }
        }
      }
    } @else if (history.error()) {
      <p class="form-error">{{ text(history.error()) }}</p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
})
export class EventPage {
  private readonly api = inject(Api);
  private readonly notices = inject(Notices);

  readonly chain = input.required<string>();

  protected readonly mode = signal<'view' | 'edit' | 'retract' | 'link'>('view');
  protected readonly reason = signal('');
  protected readonly relation = signal<Relation>('suspected_cause');
  protected readonly relations = RELATIONS;
  protected readonly words = humanize;
  protected readonly clock = clock;
  protected readonly dayLabel = (day: string) => dayLabel(day);
  protected readonly text = errorText;
  protected readonly round = (value: unknown) => Math.round(Number(value ?? 0));
  protected readonly versionText = (version: EventOut) => versionLine(version);
  protected readonly titleOf = (event: EventOut) => describeEvent(event).title;

  protected readonly history = resource({
    params: () => ({ chain_id: this.chain() }),
    loader: ({ params }) => this.api.view('event', params),
  });
  protected readonly head = computed(() => this.history.value()?.versions.at(-1) ?? null);
  protected readonly kind = computed(() => kindLabel(this.history.value()!.kind));
  protected readonly line = computed(() => describeEvent(this.head()!));
  protected readonly rows = computed(() =>
    payloadRows(this.head()!.payload as Record<string, unknown>),
  );
  protected readonly items = computed(
    () =>
      ((this.head()?.payload as Record<string, unknown>)['items'] ?? []) as {
        name: string;
        grams: number;
        nutrients?: { kcal?: number };
      }[],
  );
  protected readonly versionsNewestFirst = computed(() =>
    [...(this.history.value()?.versions ?? [])].reverse(),
  );
  protected readonly candidates = resource({
    params: () => (this.mode() === 'link' ? this.head()?.local_day : undefined),
    loader: async ({ params: day }) => {
      const [before, same] = await Promise.all([
        this.api.view('day', { date: addDays(day, -1) }),
        this.api.view('day', { date: day }),
      ]);
      return [...before.timeline, ...same.timeline].filter(
        (event) => event.chain_id !== this.chain(),
      );
    },
  });

  constructor() {
    reloadAfterCommands(this.history);
  }

  protected async retract(): Promise<void> {
    await this.run(() =>
      this.api.command('retract_event', { id: this.head()!.id, reason: this.reason() || null }),
    );
  }

  protected async link(target: EventOut): Promise<void> {
    await this.run(() =>
      this.api.command('link_events', {
        from_chain: this.chain(),
        to_chain: target.chain_id,
        relation: this.relation(),
      }),
    );
  }

  protected async unlink(link: LinkOut): Promise<void> {
    const [from_chain, to_chain] =
      link.direction === 'outgoing' ? [this.chain(), link.chain_id] : [link.chain_id, this.chain()];
    await this.run(() =>
      this.api.command('unlink_events', { from_chain, to_chain, relation: link.relation }),
    );
  }

  private async run(command: () => Promise<{ warnings?: string[] }>): Promise<void> {
    try {
      const response = await command();
      this.notices.warnings(response.warnings);
      this.mode.set('view');
    } catch (error) {
      this.notices.error(error);
    }
  }
}
```

`src/app/features/event/log.ts`:

```ts
import { Location } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import type { Kind } from '../../core/api/types';
import { EventEditor } from '../../shared/forms/event-editor';
import { KINDS } from '../../shared/timeline/describe';

/** /log/:kind: a new event of one kind; back to where the user came from afterwards. */
@Component({
  selector: 'app-log',
  imports: [EventEditor],
  template: `
    @if (known()) {
      <app-event-editor [kind]="$any(kind())" (saved)="back()" (cancelled)="back()" />
    } @else {
      <p class="form-error">Unknown kind "{{ kind() }}".</p>
    }
  `,
})
export class LogPage {
  private readonly location = inject(Location);

  readonly kind = input.required<string>();

  protected readonly known = computed(() => KINDS.includes(this.kind() as Kind));

  protected back(): void {
    this.location.back();
  }
}
```

In `src/app/app.routes.ts`, insert before `{ path: '**', redirectTo: 'today' }`:

```ts
      {
        path: 'event/:chain',
        loadComponent: () => import('./features/event/event').then((m) => m.EventPage),
      },
      {
        path: 'log/:kind',
        loadComponent: () => import('./features/event/log').then((m) => m.LogPage),
      },
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  92 passed (92)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): event detail with history, links, edit, retract, and the log screen

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Catalog

**Files:**
- Create: `frontend/src/app/features/catalog/catalog.ts`, `frontend/src/app/features/catalog/food.ts`, `frontend/src/app/features/catalog/recipe.ts`, `frontend/src/testing/catalog.ts`
- Modify: `frontend/src/app/app.routes.ts`
- Test: `frontend/src/app/features/catalog/catalog.spec.ts`, `frontend/src/app/features/catalog/food.spec.ts`, `frontend/src/app/features/catalog/recipe.spec.ts`

**Interfaces:**
- Consumes: `Api`, `reloadAfterCommands`, `errorText`, `FoodOut`, `RecipeOut`,
  `RemoteFood` (Task 1); `Notices` (Task 3); `labelFor` (Task 4); `CommandForm` (Task 7).
- Produces:
  - `CatalogPage` (`/catalog`): a search box (250 ms delay, from 2 characters) over
    `views/catalog`: saved foods (links), Open Food Facts hits with Import (→
    `import_food`, then the new food's page) or "No nutrients", the remote error if any;
    recipes filtered by the same text; "New food" and "New recipe".
  - `FoodPage` (`/catalog/food/:id`, `new` creates): facts per 100 g/ml, unit, pack,
    barcode, source and version count; Edit (`save_food` with `id`; new nutrients make a
    new version on the backend) and Archive.
  - `RecipePage` (`/catalog/recipe/:id`, `new` creates): per-portion nutrients, items,
    steps, note, version count; Edit (`save_recipe`, a new version) and Archive.
  - Spec helpers `food(overrides)`, `recipe(overrides)`.

- [ ] **Step 1: Write the failing tests**

`src/testing/catalog.ts`:

```ts
import type { FoodOut, RecipeOut } from '../app/core/api/types';

const nutrients = {
  kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
  sugar_g: 0,
  salt_g: 0,
  fluid_ml: 0,
};

export function food(overrides: Partial<FoodOut> = {}): FoodOut {
  return {
    id: 'food-1',
    name: 'Skyr',
    brand: 'Arla',
    barcode: '4001234',
    kind: 'food',
    source: 'off',
    unit_name: null,
    unit_grams: null,
    pack_grams: 450,
    archived: false,
    version_id: 'fv-2',
    per_100: {
      kcal: 63,
      protein_g: 11,
      carbs_g: 4,
      fat_g: 0.2,
      fiber_g: null,
      sugar_g: 4,
      salt_g: 0.1,
    },
    versions: 2,
    ...overrides,
  };
}

export function recipe(overrides: Partial<RecipeOut> = {}): RecipeOut {
  return {
    id: 'recipe-1',
    name: 'Overnight oats',
    version_id: 'rv-1',
    serves: 2,
    steps: ['Mix', 'Wait overnight'],
    items: [
      {
        food_id: 'food-1',
        name: 'Skyr',
        grams: 250,
        unit_name: null,
        unit_grams: null,
        nutrients: { ...nutrients, kcal: 158 },
      },
      {
        food_id: 'food-2',
        name: 'Oats',
        grams: 80,
        unit_name: null,
        unit_grams: null,
        nutrients: { ...nutrients, kcal: 297 },
      },
    ],
    totals: { ...nutrients, kcal: 455, protein_g: 38 },
    per_portion: { ...nutrients, kcal: 227.5, protein_g: 19 },
    note: null,
    archived: false,
    versions: 1,
    ...overrides,
  };
}
```

`src/app/features/catalog/catalog.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { food, recipe } from '../../../testing/catalog';
import { provideFeatureTesting, request } from '../../../testing/http';
import { CatalogPage } from './catalog';

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
});
```

`src/app/features/catalog/food.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { food } from '../../../testing/catalog';
import { provideFeatureTesting, request } from '../../../testing/http';
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
    expect((await request('/api/v2/commands/archive_food')).request.body).toEqual({ id: 'food-1' });
  });
});
```

`src/app/features/catalog/recipe.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
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
    expect(element.querySelectorAll('.items tr')).toHaveLength(2);

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
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./catalog"`, `"./food"` and `"./recipe"`.

- [ ] **Step 3: Implement**

`src/app/features/catalog/catalog.ts`:

```ts
import { Component, computed, inject, resource, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { RemoteFood } from '../../core/api/types';
import { Notices } from '../../core/notices';

const SEARCH_DELAY_MS = 250;

/** Catalog search: local foods, Open Food Facts hits to import, and recipes. */
@Component({
  selector: 'app-catalog',
  imports: [RouterLink],
  template: `
    <header class="page-head">
      <h1>Catalog</h1>
    </header>
    <input
      type="search"
      name="q"
      placeholder="Search foods and recipes"
      [value]="typed()"
      (input)="type($any($event.target).value)"
    />
    <div class="actions">
      <a class="button secondary" routerLink="/catalog/food/new">New food</a>
      <a class="button secondary" routerLink="/catalog/recipe/new">New recipe</a>
    </div>
    @if (foods.value(); as found) {
      <h2>Foods</h2>
      <ul class="list">
        @for (food of found.local; track food.id) {
          <li>
            <a [routerLink]="['/catalog/food', food.id]">
              {{ food.name }} <small>{{ food.brand }} · {{ food.per_100.kcal }} kcal/100</small>
            </a>
          </li>
        } @empty {
          <li class="muted">No saved food matches.</li>
        }
      </ul>
      @if (found.remote.length) {
        <h2>Open Food Facts</h2>
        <ul class="list">
          @for (hit of found.remote; track hit.barcode) {
            <li>
              <span
                >{{ hit.name }} <small>{{ hit.brand }}</small></span
              >
              <button type="button" class="link" [disabled]="!hit.usable" (click)="import(hit)">
                {{ hit.usable ? 'Import' : 'No nutrients' }}
              </button>
            </li>
          }
        </ul>
      }
      @if (found.remote_error) {
        <p class="muted">Open Food Facts: {{ found.remote_error }}</p>
      }
    } @else if (foods.error()) {
      <p class="form-error">{{ text(foods.error()) }}</p>
    }
    <h2>Recipes</h2>
    <ul class="list">
      @for (recipe of recipes(); track recipe.id) {
        <li>
          <a [routerLink]="['/catalog/recipe', recipe.id]">
            {{ recipe.name }} <small>{{ round(recipe.per_portion.kcal) }} kcal/portion</small>
          </a>
        </li>
      } @empty {
        <li class="muted">No recipe matches.</li>
      }
    </ul>
  `,
})
export class CatalogPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly typed = signal('');
  protected readonly query = signal('');
  protected readonly text = errorText;
  protected readonly round = (value: number | undefined) => Math.round(value ?? 0);
  protected readonly foods = resource({
    params: () => (this.query().length >= 2 ? { q: this.query() } : undefined),
    loader: ({ params }) => this.api.view('catalog', { q: params.q }),
  });
  protected readonly allRecipes = resource({ loader: () => this.api.view('recipes') });
  protected readonly recipes = computed(() => {
    const needle = this.query().toLowerCase();
    return (this.allRecipes.value()?.recipes ?? []).filter((recipe) =>
      recipe.name.toLowerCase().includes(needle),
    );
  });

  constructor() {
    reloadAfterCommands(this.foods);
    reloadAfterCommands(this.allRecipes);
  }

  protected type(text: string): void {
    this.typed.set(text);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.query.set(text.trim()), SEARCH_DELAY_MS);
  }

  protected async import(hit: RemoteFood): Promise<void> {
    try {
      const { result } = await this.api.command('import_food', { barcode: hit.barcode });
      await this.router.navigate(['/catalog/food', result.id]);
    } catch (error) {
      this.notices.error(error);
    }
  }
}
```

`src/app/features/catalog/food.ts`:

```ts
import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { FoodOut } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { CommandForm } from '../../shared/forms/command-form';
import { labelFor } from '../../shared/forms/schema';

/** A food: facts per 100 g, its version count and source; edit (new nutrients = new version) or archive. */
@Component({
  selector: 'app-food',
  imports: [CommandForm],
  template: `
    @if (isNew()) {
      <h1>New food</h1>
      <app-command-form
        command="save_food"
        [omit]="['id']"
        [initial]="{ kind: 'food' }"
        (done)="created($event)"
        (cancelled)="back()"
      />
    } @else if (food.value(); as current) {
      <header class="page-head">
        <h1>{{ current.name }}</h1>
      </header>
      <p class="muted">
        {{ current.brand ?? 'no brand' }} · {{ current.kind }} ·
        {{ current.source === 'off' ? 'Open Food Facts' : 'manual' }} · version
        {{ current.versions }}
        @if (current.archived) {
          · archived
        }
      </p>
      @if (editing()) {
        <app-command-form
          command="save_food"
          [fixed]="{ id: current.id }"
          [initial]="editable(current)"
          (done)="editing.set(false)"
          (cancelled)="editing.set(false)"
        />
      } @else {
        <h2>Per 100 {{ current.kind === 'drink' ? 'ml' : 'g' }}</h2>
        <dl class="rows">
          @for (row of per100(); track row[0]) {
            <dt>{{ row[0] }}</dt>
            <dd>{{ row[1] }}</dd>
          }
          @if (current.unit_name) {
            <dt>Unit</dt>
            <dd>1 {{ current.unit_name }} = {{ current.unit_grams }} g</dd>
          }
          @if (current.pack_grams) {
            <dt>Pack</dt>
            <dd>{{ current.pack_grams }} g</dd>
          }
          @if (current.barcode) {
            <dt>Barcode</dt>
            <dd>{{ current.barcode }}</dd>
          }
        </dl>
        @if (!current.archived) {
          <div class="actions">
            <button type="button" (click)="editing.set(true)">Edit</button>
            <button type="button" class="danger" (click)="archive(current)">Archive</button>
          </div>
        }
      }
    } @else if (food.error()) {
      <p class="form-error">{{ text(food.error()) }}</p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
})
export class FoodPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);

  readonly id = input.required<string>();

  protected readonly isNew = computed(() => this.id() === 'new');
  protected readonly editing = signal(false);
  protected readonly text = errorText;
  protected readonly food = resource({
    params: () => (this.isNew() ? undefined : { id: this.id() }),
    loader: ({ params }) => this.api.view('food', { id: params.id }),
  });
  protected readonly per100 = computed(() =>
    Object.entries(this.food.value()?.per_100 ?? {})
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [labelFor(key), String(value)]),
  );

  constructor() {
    reloadAfterCommands(this.food);
  }

  protected editable(food: FoodOut): Record<string, unknown> {
    const { name, brand, kind, unit_name, unit_grams, pack_grams, per_100 } = food;
    return { name, brand, kind, unit_name, unit_grams, pack_grams, per_100 };
  }

  protected async created(result: unknown): Promise<void> {
    await this.router.navigate(['/catalog/food', (result as FoodOut).id], { replaceUrl: true });
  }

  protected async archive(food: FoodOut): Promise<void> {
    try {
      await this.api.command('archive_food', { id: food.id });
    } catch (error) {
      this.notices.error(error);
    }
  }

  protected back(): void {
    void this.router.navigate(['/catalog']);
  }
}
```

`src/app/features/catalog/recipe.ts`:

```ts
import { Component, computed, inject, input, resource, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { RecipeOut } from '../../core/api/types';
import { Notices } from '../../core/notices';
import { CommandForm } from '../../shared/forms/command-form';

/** A recipe: items with nutrients, totals per portion, steps and version count; edit or archive. */
@Component({
  selector: 'app-recipe',
  imports: [CommandForm, RouterLink],
  template: `
    @if (isNew()) {
      <h1>New recipe</h1>
      <app-command-form
        command="save_recipe"
        [omit]="['id']"
        [initial]="{ serves: 1 }"
        (done)="created($event)"
        (cancelled)="back()"
      />
    } @else if (recipe.value(); as current) {
      <header class="page-head">
        <h1>{{ current.name }}</h1>
      </header>
      <p class="muted">
        serves {{ current.serves }} · version {{ current.versions }}
        @if (current.archived) {
          · archived
        }
      </p>
      @if (editing()) {
        <app-command-form
          command="save_recipe"
          [fixed]="{ id: current.id }"
          [initial]="editable(current)"
          (done)="editing.set(false)"
          (cancelled)="editing.set(false)"
        />
      } @else {
        <p>
          Per portion: {{ round(current.per_portion.kcal) }} kcal · P
          {{ round(current.per_portion.protein_g) }} g · C
          {{ round(current.per_portion.carbs_g) }} g · F {{ round(current.per_portion.fat_g) }} g
        </p>
        <table class="items">
          @for (item of current.items; track item.food_id) {
            <tr>
              <td>
                <a [routerLink]="['/catalog/food', item.food_id]">{{ item.name }}</a>
              </td>
              <td class="num">{{ item.grams }} g</td>
              <td class="num">{{ round(item.nutrients.kcal) }} kcal</td>
            </tr>
          }
        </table>
        @if (current.steps.length) {
          <h2>Steps</h2>
          <ol>
            @for (step of current.steps; track $index) {
              <li>{{ step }}</li>
            }
          </ol>
        }
        @if (current.note) {
          <p>{{ current.note }}</p>
        }
        @if (!current.archived) {
          <div class="actions">
            <button type="button" (click)="editing.set(true)">Edit</button>
            <button type="button" class="danger" (click)="archive(current)">Archive</button>
          </div>
        }
      }
    } @else if (recipe.error()) {
      <p class="form-error">{{ text(recipe.error()) }}</p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
})
export class RecipePage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly notices = inject(Notices);

  readonly id = input.required<string>();

  protected readonly isNew = computed(() => this.id() === 'new');
  protected readonly editing = signal(false);
  protected readonly text = errorText;
  protected readonly round = (value: number | undefined) => Math.round(value ?? 0);
  protected readonly recipe = resource({
    params: () => (this.isNew() ? undefined : { id: this.id() }),
    loader: ({ params }) => this.api.view('recipe', { id: params.id }),
  });

  constructor() {
    reloadAfterCommands(this.recipe);
  }

  protected editable(recipe: RecipeOut): Record<string, unknown> {
    const { name, serves, steps, items, note } = recipe;
    return { name, serves, steps, items, note };
  }

  protected async created(result: unknown): Promise<void> {
    await this.router.navigate(['/catalog/recipe', (result as RecipeOut).id], { replaceUrl: true });
  }

  protected async archive(recipe: RecipeOut): Promise<void> {
    try {
      await this.api.command('archive_recipe', { id: recipe.id });
    } catch (error) {
      this.notices.error(error);
    }
  }

  protected back(): void {
    void this.router.navigate(['/catalog']);
  }
}
```

In `src/app/app.routes.ts`, insert before `{ path: '**', redirectTo: 'today' }`:

```ts
      {
        path: 'catalog',
        loadComponent: () => import('./features/catalog/catalog').then((m) => m.CatalogPage),
      },
      {
        path: 'catalog/food/:id',
        loadComponent: () => import('./features/catalog/food').then((m) => m.FoodPage),
      },
      {
        path: 'catalog/recipe/:id',
        loadComponent: () => import('./features/catalog/recipe').then((m) => m.RecipePage),
      },
```

- [ ] **Step 4: Run the tests**

Run: `npm run lint && npm test`
Expected: `Tests  95 passed (95)`.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): catalog search with Open Food Facts import, food and recipe pages

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Profile

**Files:**
- Create: `frontend/src/app/features/profile/derivation.ts`, `frontend/src/app/features/profile/profile.ts`
- Modify: `frontend/src/app/app.routes.ts`
- Replace: `frontend/src/app/app.spec.ts`
- Test: `frontend/src/app/features/profile/derivation.spec.ts`, `frontend/src/app/features/profile/profile.spec.ts`

**Interfaces:**
- Consumes: `Api`, `reloadAfterCommands`, `errorText`, `EnergyOut`, `ProfileOut`,
  `SyncStatusOut`, `TargetsOut` (Task 1); `Auth` (Task 2); `Notices`, `clock`,
  `dayLabel`, `localDay` (Task 3); `labelFor` (Task 4); `CommandForm` (Task 7);
  `views/profile` and `views/today` (for the energy parts and the weight).
- Produces:
  - `derivation(profile, targets, energy, weightKg) → string[]`: maintenance from BMR ×
    1.2 plus steps and workouts, the goal adjustment, the energy target, protein
    (g/kg × weight), fat (the larger of the g/kg floor and 25 % of energy ÷ 9), carbs
    (the rest ÷ 4), then missing inputs and the backend's warnings (spec §4.4).
  - `ProfilePage` (`/profile`): body and goal (Edit → `update_profile`), targets with the
    derivation, source preferences (Edit/Add → `set_source_preference`), integrations
    with status, counts and last error, and "Sync now" (→ `sync_now`, result as a notice);
    "Sign out".

- [ ] **Step 1: Write the failing tests**

`src/app/features/profile/derivation.spec.ts`:

```ts
import { summary } from '../../../testing/views';
import { derivation } from './derivation';

const profile = {
  id: 'p1',
  valid_from: '2026-09-01T00:00:00Z',
  timezone: 'Europe/Berlin',
  height_cm: 182,
  birth_date: '1999-05-01',
  sex: 'male' as const,
  goal_weight_kg: 78,
  goal_date: '2026-12-31',
  protein_g_per_kg: 1.8,
  fat_g_per_kg_min: 0.8,
  gym_sessions_per_week: 3,
};

describe('derivation', () => {
  it('explains every target from its inputs', () => {
    const { targets, energy } = summary();
    expect(derivation(profile, targets, energy, 81.4)).toEqual([
      'Maintenance 2346 kcal = BMR 1780 × 1.2 (2136) + steps 210 + workouts 0',
      'Adjustment −500 kcal/day toward 78 kg by 2026-12-31',
      'Energy target 1846 kcal',
      'Protein 147 g = 1.8 g/kg × 81.4 kg',
      'Fat 58 g = the larger of 0.8 g/kg × 81.4 kg and 25 % of 1846 kcal ÷ 9',
      'Carbs 183 g = the energy left ÷ 4',
    ]);
  });

  it('names what is missing instead of guessing', () => {
    const empty = {
      kcal: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      adjustment_kcal: null,
      missing: ['height_cm', 'weight_kg'],
      warnings: [],
    };
    const energy = {
      bmr: null,
      baseline: null,
      steps_kcal: 0,
      workouts_kcal: 0,
      maintenance: null,
    };
    expect(derivation(null, empty, energy, null)).toEqual([
      'Missing for targets: height_cm, weight_kg',
    ]);
  });
});
```

`src/app/features/profile/profile.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideFeatureTesting, request } from '../../../testing/http';
import { context, summary } from '../../../testing/views';
import type { ProfileView } from '../../core/api/types';
import { ProfilePage } from './profile';

const view: ProfileView = {
  profile: {
    id: 'p1',
    valid_from: '2026-09-01T00:00:00Z',
    timezone: 'Europe/Berlin',
    height_cm: 182,
    birth_date: '1999-05-01',
    sex: 'male',
    goal_weight_kg: 78,
    goal_date: '2026-12-31',
    protein_g_per_kg: 1.8,
    fat_g_per_kg_min: 0.8,
    gym_sessions_per_week: 3,
  },
  targets_today: summary().targets,
  source_preferences: [{ metric: 'steps', sources: ['ring', 'app'] }],
  integrations: [
    {
      source: 'gym-bro',
      configured: true,
      last_attempt_at: '2026-09-29T06:00:00Z',
      last_success_at: '2026-09-29T06:00:00Z',
      last_error: null,
      counts: { created: 2 },
    },
  ],
};

describe('ProfilePage', () => {
  it('shows body data, the target derivation, preferences and integrations, and syncs now', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(ProfilePage);
    (await request('/api/v2/views/profile')).flush(view);
    (await request('/api/v2/views/today')).flush(context());
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelectorAll('.derivation li').length).toBeGreaterThan(0);
    });
    expect(element.querySelector('.rows')!.textContent).toContain('Goal weight (kg)');
    expect(element.textContent).toContain('Protein 147 g = 1.8 g/kg × 81.4 kg');
    expect(element.textContent).toContain('steps: ring → app');
    expect(element.querySelector('.integration')!.textContent).toContain('(2 created)');

    [...element.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Sync now')!
      .click();
    expect((await request('/api/v2/commands/sync_now')).request.body).toEqual({
      source: 'gym-bro',
    });
  });
});
```

Replace `src/app/app.spec.ts` (every screen of spec §8 is now routed):

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  it('shows the four main tabs', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const tabs = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.tabs a')];
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual([
      '/today',
      '/diary',
      '/catalog',
      '/profile',
    ]);
  });

  it('routes every screen of spec §8 behind the login guard', () => {
    const guarded = routes.find((route) => route.canActivateChild)!;
    expect(guarded.children!.map((route) => route.path)).toEqual([
      '',
      'today',
      'day/:date',
      'diary',
      'event/:chain',
      'log/:kind',
      'catalog',
      'catalog/food/:id',
      'catalog/recipe/:id',
      'profile',
      '**',
    ]);
    expect(routes.map((route) => route.path)).toContain('callback');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: the build fails with `Could not resolve "./derivation"` and `"./profile"`.

- [ ] **Step 3: Implement**

`src/app/features/profile/derivation.ts`:

```ts
import type { EnergyOut, ProfileOut, TargetsOut } from '../../core/api/types';

const r = (value: number | null | undefined) => Math.round(value ?? 0);

/**
 * Today's targets explained step by step, following the backend's rules (spec §4.4): maintenance,
 * the goal adjustment, then protein, fat (with its floor) and carbs from what is left.
 */
export function derivation(
  profile: ProfileOut | null,
  targets: TargetsOut,
  energy: EnergyOut,
  weightKg: number | null,
): string[] {
  const lines: string[] = [];
  if (energy.maintenance !== null) {
    lines.push(
      `Maintenance ${r(energy.maintenance)} kcal = BMR ${r(energy.bmr)} × 1.2 (${r(energy.baseline)})` +
        ` + steps ${r(energy.steps_kcal)} + workouts ${r(energy.workouts_kcal)}`,
    );
  }
  if (targets.adjustment_kcal) {
    const sign = targets.adjustment_kcal > 0 ? '+' : '−';
    const goal = profile?.goal_weight_kg
      ? ` toward ${profile.goal_weight_kg} kg by ${profile.goal_date}`
      : '';
    lines.push(`Adjustment ${sign}${Math.abs(r(targets.adjustment_kcal))} kcal/day${goal}`);
  }
  if (targets.kcal != null) {
    lines.push(`Energy target ${r(targets.kcal)} kcal`);
  }
  if (targets.protein_g != null && profile && weightKg !== null) {
    lines.push(
      `Protein ${r(targets.protein_g)} g = ${profile.protein_g_per_kg} g/kg × ${weightKg} kg`,
    );
  }
  if (targets.fat_g != null && targets.kcal != null && profile && weightKg !== null) {
    lines.push(
      `Fat ${r(targets.fat_g)} g = the larger of ${profile.fat_g_per_kg_min} g/kg × ${weightKg} kg` +
        ` and 25 % of ${r(targets.kcal)} kcal ÷ 9`,
    );
  }
  if (targets.carbs_g != null) {
    lines.push(`Carbs ${r(targets.carbs_g)} g = the energy left ÷ 4`);
  }
  const missing = targets.missing ?? [];
  if (missing.length) {
    lines.push(`Missing for targets: ${missing.join(', ')}`);
  }
  return [...lines, ...(targets.warnings ?? [])];
}
```

`src/app/features/profile/profile.ts`:

```ts
import { Component, computed, inject, resource, signal } from '@angular/core';
import { Api, reloadAfterCommands } from '../../core/api/api';
import { errorText } from '../../core/api/errors';
import type { SyncStatusOut } from '../../core/api/types';
import { Auth } from '../../core/auth/auth';
import { Notices } from '../../core/notices';
import { CommandForm } from '../../shared/forms/command-form';
import { labelFor } from '../../shared/forms/schema';
import { clock, dayLabel, localDay } from '../../shared/time';
import { derivation } from './derivation';

const PROFILE_FIELDS = [
  'timezone',
  'height_cm',
  'birth_date',
  'sex',
  'goal_weight_kg',
  'goal_date',
  'protein_g_per_kg',
  'fat_g_per_kg_min',
  'gym_sessions_per_week',
] as const;

/** Body data and goal, targets with their derivation, source preferences and integrations. */
@Component({
  selector: 'app-profile',
  imports: [CommandForm],
  template: `
    <header class="page-head">
      <h1>Profile</h1>
    </header>
    @if (view.value(); as current) {
      <h2>Body and goal</h2>
      @if (editing() === 'profile') {
        <app-command-form
          command="update_profile"
          [initial]="profileValues()"
          (done)="editing.set(null)"
          (cancelled)="editing.set(null)"
        />
      } @else {
        <dl class="rows">
          @for (row of profileRows(); track row[0]) {
            <dt>{{ row[0] }}</dt>
            <dd>{{ row[1] }}</dd>
          }
        </dl>
        <button type="button" class="secondary" (click)="editing.set('profile')">Edit</button>
      }

      <h2>Targets today</h2>
      <ul class="derivation">
        @for (line of explanation(); track line) {
          <li>{{ line }}</li>
        }
      </ul>

      <h2>Source preferences</h2>
      @if (editing() === 'preference') {
        <app-command-form
          command="set_source_preference"
          [initial]="preference()"
          (done)="editing.set(null)"
          (cancelled)="editing.set(null)"
        />
      } @else {
        <ul class="list">
          @for (item of current.source_preferences; track item.metric) {
            <li>
              <span>{{ item.metric }}: {{ item.sources.join(' → ') }}</span>
              <button
                type="button"
                class="link"
                (click)="editPreference(item.metric, item.sources)"
              >
                Edit
              </button>
            </li>
          } @empty {
            <li class="muted">None set; the newest value wins.</li>
          }
        </ul>
        <button type="button" class="secondary" (click)="editPreference('', [])">
          Add preference
        </button>
      }

      <h2>Integrations</h2>
      <ul class="list">
        @for (status of current.integrations; track status.source) {
          <li class="integration">
            <span>
              <b>{{ status.source }}</b>
              {{ statusText(status) }}
              @if (status.last_error) {
                <span class="form-error">{{ status.last_error }}</span>
              }
            </span>
            <button
              type="button"
              class="link"
              [disabled]="!status.configured || syncing() === status.source"
              (click)="sync(status.source)"
            >
              {{ syncing() === status.source ? 'Syncing…' : 'Sync now' }}
            </button>
          </li>
        } @empty {
          <li class="muted">No integrations configured.</li>
        }
      </ul>
    } @else if (view.error()) {
      <p class="form-error">{{ text(view.error()) }}</p>
    } @else {
      <p class="muted">Loading…</p>
    }
    <button type="button" class="secondary signout" (click)="auth.logout()">Sign out</button>
  `,
})
export class ProfilePage {
  private readonly api = inject(Api);
  private readonly notices = inject(Notices);
  protected readonly auth = inject(Auth);

  protected readonly editing = signal<'profile' | 'preference' | null>(null);
  protected readonly preference = signal<Record<string, unknown>>({});
  protected readonly syncing = signal<string | null>(null);
  protected readonly text = errorText;
  protected readonly view = resource({ loader: () => this.api.view('profile') });
  protected readonly today = resource({ loader: () => this.api.view('today') });
  protected readonly profileValues = computed(() => {
    const profile = this.view.value()?.profile;
    return Object.fromEntries(PROFILE_FIELDS.map((key) => [key, profile?.[key] ?? null]));
  });
  protected readonly profileRows = computed(() =>
    Object.entries(this.profileValues()).map(([key, value]) => [
      labelFor(key),
      value === null ? '–' : String(value),
    ]),
  );
  protected readonly explanation = computed(() => {
    const view = this.view.value();
    const today = this.today.value();
    if (!view || !today) {
      return [];
    }
    return derivation(
      view.profile,
      view.targets_today,
      today.day.summary.energy,
      today.weight.latest_kg,
    );
  });

  constructor() {
    reloadAfterCommands(this.view);
    reloadAfterCommands(this.today);
  }

  protected editPreference(metric: string, sources: string[]): void {
    this.preference.set({ metric, sources });
    this.editing.set('preference');
  }

  protected statusText(status: SyncStatusOut): string {
    if (!status.configured) {
      return 'not configured';
    }
    if (!status.last_success_at) {
      return 'never synced';
    }
    const day = localDay(new Date(status.last_success_at));
    const counts = Object.entries(status.counts)
      .map(([key, value]) => `${value} ${key}`)
      .join(', ');
    return `synced ${dayLabel(day).toLowerCase()} ${clock(status.last_success_at)}${counts ? ` (${counts})` : ''}`;
  }

  protected async sync(source: string): Promise<void> {
    this.syncing.set(source);
    try {
      const { result } = await this.api.command('sync_now', { source });
      this.notices.show(
        result.last_error ? `${source}: ${result.last_error}` : `${source} synced`,
        result.last_error ? 'error' : 'info',
      );
    } catch (error) {
      this.notices.error(error);
    } finally {
      this.syncing.set(null);
    }
  }
}
```

In `src/app/app.routes.ts`, insert before `{ path: '**', redirectTo: 'today' }`:

```ts
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile').then((m) => m.ProfilePage),
      },
```

The whole file is now:

```ts
import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth';
import { Callback } from './core/auth/callback';

export const routes: Routes = [
  { path: 'callback', component: Callback },
  {
    path: '',
    canActivateChild: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'today' },
      {
        path: 'today',
        loadComponent: () => import('./features/today/today').then((m) => m.TodayPage),
      },
      {
        path: 'day/:date',
        loadComponent: () => import('./features/day/day').then((m) => m.DayPage),
      },
      {
        path: 'diary',
        loadComponent: () => import('./features/diary/diary').then((m) => m.DiaryPage),
      },
      {
        path: 'event/:chain',
        loadComponent: () => import('./features/event/event').then((m) => m.EventPage),
      },
      {
        path: 'log/:kind',
        loadComponent: () => import('./features/event/log').then((m) => m.LogPage),
      },
      {
        path: 'catalog',
        loadComponent: () => import('./features/catalog/catalog').then((m) => m.CatalogPage),
      },
      {
        path: 'catalog/food/:id',
        loadComponent: () => import('./features/catalog/food').then((m) => m.FoodPage),
      },
      {
        path: 'catalog/recipe/:id',
        loadComponent: () => import('./features/catalog/recipe').then((m) => m.RecipePage),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile').then((m) => m.ProfilePage),
      },
      { path: '**', redirectTo: 'today' },
    ],
  },
];
```

- [ ] **Step 4: Run the tests and the build**

Run: `npm run lint && npm test && npm run build`
Expected: `Test Files  26 passed (26)`, `Tests  98 passed (98)`; the build reports an initial
total of about 285 kB raw / 80 kB transferred and no budget warning.

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend
git commit -m "feat(frontend): profile with target derivation, source preferences and sync now

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---


### Task 13: Container, dev stack, CI, UI smoke check, README and spec

**Files:**
- Create: `frontend/Dockerfile`, `frontend/.dockerignore`, `frontend/docker/default.conf.template`, `frontend/docker/40-runtime-config.sh`, `e2e/ui_smoke.py`
- Modify: `docker-compose.yml`, `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/specs/2026-09-29-daily2-core-design.md`

**Interfaces:**
- Consumes: the whole app (Tasks 0–12).
- Produces: an image with stages `deps` → `test` (Prettier + Vitest; `docker build
  --target test frontend` fails when either fails) and `build` → `prod` (nginx on port 80, `GET /healthz` for health checks).
  The `prod` container reads `BACKEND_URL` (default `http://backend:8000`), `API_BASE`
  (`/api/v2`), `KEYCLOAK_URL` (`http://localhost:18180`), `KEYCLOAK_REALM` (`daily2`) and
  `KEYCLOAK_CLIENT_ID` (`daily2-app`); it proxies `/api/` and `/health` (nothing else,
  in particular not `/mcp`) and writes `assets/runtime-config.json` at start. Plan 3 sets these
  variables for the homelab.

- [ ] **Step 1: Write the failing check**

`e2e/ui_smoke.py` (no browser: the container, its proxy and config, and the app's PKCE
login against the real Keycloak):

```python
"""UI smoke check without a browser: the frontend container serves the app, its runtime
config and the backend through its proxy, and Keycloak accepts the app's PKCE login.

Run against `docker compose --profile ui up -d --build --wait`:
    uv run --project backend python e2e/ui_smoke.py
"""

import base64
import hashlib
import re
import secrets
import sys
from html import unescape
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

UI = "http://localhost:18101"
REALM = "http://localhost:18180/realms/daily2/protocol/openid-connect"
CLIENT = "daily2-app"
REDIRECT = f"{UI}/callback"


def check(name: str, condition: bool, detail: Any = "") -> None:
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        print(f"     {detail}")
        sys.exit(1)


def pkce_login(client: httpx.Client) -> dict[str, Any]:
    """The browser's login, step by step: authorize, submit the form, exchange the code.

    Keycloak marks its login cookies Secure; browsers send those to http://localhost, but
    httpx does not, so they are passed on by hand.
    """
    verifier = secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    state = secrets.token_urlsafe(16)
    query = {
        "client_id": CLIENT,
        "response_type": "code",
        "scope": "openid",
        "redirect_uri": REDIRECT,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    page = client.get(f"{REALM}/auth?{urlencode(query)}")
    check("keycloak shows the login form", page.status_code == 200, page.text[:300])
    action = re.search(r'action="([^"]+)"', page.text)
    check("the login form has an action", action is not None, page.text[:300])
    cookies = "; ".join(f"{name}={value}" for name, value in page.cookies.items())
    submitted = client.post(
        unescape(action.group(1)),
        data={"username": "dev", "password": "dev"},
        headers={"Cookie": cookies},
    )
    location = submitted.headers.get("location", "")
    check("keycloak redirects to the app's callback", location.startswith(REDIRECT), location)
    params = parse_qs(urlparse(location).query)
    check("the callback carries our state", params.get("state") == [state], params)
    tokens = client.post(
        f"{REALM}/token",
        data={
            "client_id": CLIENT,
            "grant_type": "authorization_code",
            "code": params["code"][0],
            "redirect_uri": REDIRECT,
            "code_verifier": verifier,
        },
        headers={"Origin": UI},
    )
    check("the code exchange succeeds", tokens.status_code == 200, tokens.text)
    check(
        "keycloak allows the app's origin (CORS)",
        tokens.headers.get("access-control-allow-origin") == UI,
        dict(tokens.headers),
    )
    return tokens.json()


def main() -> None:
    ui = httpx.Client(base_url=UI, timeout=20)
    index = ui.get("/")
    check("index.html is served", index.status_code == 200 and "<app-root>" in index.text)
    check(
        "index.html has no inline script (the CSP forbids them)",
        re.search(r"<script(?![^>]*\bsrc=)[^>]*>", index.text) is None,
        index.text,
    )
    check("a deep link falls back to index.html", "<app-root>" in ui.get("/diary").text)
    check("the service worker manifest exists", ui.get("/ngsw.json").status_code == 200)
    check("/healthz answers for container health checks", ui.get("/healthz").text == "ok\n")
    config = ui.get("/assets/runtime-config.json")
    check(
        "assets/runtime-config.json comes from the container environment",
        config.json()
        == {
            "apiBase": "/api/v2",
            "keycloakUrl": "http://localhost:18180",
            "realm": "daily2",
            "clientId": CLIENT,
        },
        config.text,
    )
    cache = config.headers.get("cache-control", "")
    check("assets/runtime-config.json is not cached", "no-cache" in cache, cache)
    check("/health is proxied to the backend", ui.get("/health").json().get("status") == "ok")
    anonymous = ui.get("/api/v2/views/today")
    check(
        "/api is proxied and asks for a token",
        anonymous.status_code == 401 and anonymous.json().get("code") == "unauthorized",
        anonymous.text,
    )

    with httpx.Client(timeout=20, follow_redirects=False) as browser:
        tokens = pkce_login(browser)
    authed = {"Authorization": f"Bearer {tokens['access_token']}"}
    today = ui.get("/api/v2/views/today", headers=authed)
    check("the PKCE token opens Today through the proxy", today.status_code == 200, today.text)
    check("Today has four gauges", len(today.json()["day"]["summary"]["gauges"]) == 4)
    refreshed = httpx.post(
        f"{REALM}/token",
        data={
            "client_id": CLIENT,
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=20,
    )
    check("the refresh token works", refreshed.status_code == 200, refreshed.text)
    logout = httpx.get(
        f"{REALM}/logout",
        params={
            "client_id": CLIENT,
            "post_logout_redirect_uri": f"{UI}/",
            "id_token_hint": tokens["id_token"],
        },
        timeout=20,
    )
    check(
        "keycloak logs out back to the app",
        logout.status_code == 302 and logout.headers.get("location") == f"{UI}/",
        f"{logout.status_code} {logout.headers.get('location')} {logout.text[:200]}",
    )
    print("All UI checks passed.")


if __name__ == "__main__":
    main()
```

Run from the repository root:

```bash
docker stop daily2-testdb
docker compose up -d --build --wait
uv run --project backend python e2e/ui_smoke.py
```

Expected: it stops with `httpx.ConnectError` on the first request (nothing listens on 18101
yet). Leave the stack running for Step 3.

- [ ] **Step 2: The image**

`frontend/Dockerfile`:

```dockerfile
# Stages: deps → test (prettier + unit tests, `docker build --target test`) · build → prod (nginx).
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .

FROM deps AS test
ENV CI=true TZ=Europe/Berlin
RUN npx prettier --check . && npx ng test --watch=false

FROM deps AS build
RUN npx ng build

FROM nginx:1.30-alpine AS prod
ENV BACKEND_URL=http://backend:8000 \
    API_BASE=/api/v2 \
    KEYCLOAK_URL=http://localhost:18180 \
    KEYCLOAK_REALM=daily2 \
    KEYCLOAK_CLIENT_ID=daily2-app
COPY docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist/daily2-frontend/browser /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
```

`frontend/.dockerignore`:

```text
node_modules
dist
.angular
.vscode
Dockerfile
.dockerignore
```

`frontend/docker/40-runtime-config.sh` (the nginx image runs every script in
`/docker-entrypoint.d/` before it starts):

```sh
#!/bin/sh
# Writes assets/runtime-config.json from the environment, so one image serves every deployment.
set -eu
mkdir -p /usr/share/nginx/html/assets
cat > /usr/share/nginx/html/assets/runtime-config.json <<JSON
{
  "apiBase": "${API_BASE}",
  "keycloakUrl": "${KEYCLOAK_URL}",
  "realm": "${KEYCLOAK_REALM}",
  "clientId": "${KEYCLOAK_CLIENT_ID}"
}
JSON
echo "runtime-config.json written for ${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}"
```

`frontend/docker/default.conf.template` (the nginx image substitutes only variables that
are set, so `$host` and friends stay nginx variables; `expires` is used instead of
per-location `add_header`, so the security headers apply everywhere):

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    add_header Content-Security-Policy "default-src 'self'; connect-src 'self' ${KEYCLOAK_URL}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    location /api/ {
        proxy_pass ${BACKEND_URL};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /health {
        proxy_pass ${BACKEND_URL};
    }

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    location = /assets/runtime-config.json {
        expires -1;
    }

    location = /index.html {
        expires -1;
    }

    location = /ngsw.json {
        expires -1;
    }

    location = /ngsw-worker.js {
        expires -1;
    }

    location ~* \.(?:js|css)$ {
        expires max;
    }

    location / {
        expires -1;
        try_files $uri $uri/ /index.html;
    }
}
```

Check the current tags before committing: `node` 24 is the active LTS line and `nginx`
1.30 the stable line when this plan was written; use the current LTS and stable minors.

Run: `docker build --target test frontend`
Expected: the build succeeds; its log shows `All matched files use Prettier code style!`
and `Tests  98 passed (98)` (use `--progress=plain --no-cache` to see them).

- [ ] **Step 3: Compose**

In `docker-compose.yml`, add after the `backend` service:

```yaml
  frontend:
    build: ./frontend
    profiles: [ui]
    depends_on:
      backend: { condition: service_healthy }
    environment:
      BACKEND_URL: http://backend:8000
      KEYCLOAK_URL: http://localhost:18180
      KEYCLOAK_REALM: daily2
      KEYCLOAK_CLIENT_ID: daily2-app
    ports: ["18101:80"]
```

Run from the repository root:

```bash
docker compose --profile ui up -d --build --wait
uv run --project backend python e2e/scenario.py
uv run --project backend python e2e/ui_smoke.py
```

Expected: `All checks passed.` and then:

```
PASS index.html is served
PASS index.html has no inline script (the CSP forbids them)
PASS a deep link falls back to index.html
PASS the service worker manifest exists
PASS /healthz answers for container health checks
PASS assets/runtime-config.json comes from the container environment
PASS assets/runtime-config.json is not cached
PASS /health is proxied to the backend
PASS /api is proxied and asks for a token
PASS keycloak shows the login form
PASS the login form has an action
PASS keycloak redirects to the app's callback
PASS the callback carries our state
PASS the code exchange succeeds
PASS keycloak allows the app's origin (CORS)
PASS the PKCE token opens Today through the proxy
PASS Today has four gauges
PASS the refresh token works
PASS keycloak logs out back to the app
All UI checks passed.
```

- [ ] **Step 4: Look at it on a phone-sized screen**

With the stack still up, open `http://localhost:18101` in a browser with the device
toolbar at 390 × 844, sign in as `dev`/`dev` and walk through: Today (four gauges, "+"),
log a breakfast via the food picker (search "oat", import an Open Food Facts hit), log a
symptom and link it to the breakfast from its event page, edit the breakfast (history shows
"corrected by app at …"), retract the symptom, scroll the Diary, open a Day, edit a food,
create a recipe, edit the profile and press "Sync now". Also check the dark theme. Note
anything that looks wrong in the PR; fix what is in scope. Then:

```bash
docker compose --profile ui down -v && docker start daily2-testdb
```

- [ ] **Step 5: CI**

Replace `.github/workflows/ci.yml` with (the `backend` job is unchanged; `frontend` is
new; `e2e` starts the UI too and runs the smoke check):

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_USER: daily2
          POSTGRES_PASSWORD: daily2
          POSTGRES_DB: daily2_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U daily2" --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      TEST_DATABASE_URL: postgresql+psycopg://daily2:daily2@localhost:5432/daily2_test
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v10
        with:
          python-version: "3.14"
      - run: uv sync --frozen
      - run: uv run ruff check
      - run: uv run ruff format --check
      - run: uv run pytest -q
      - name: Migrations round trip
        env:
          PGPASSWORD: daily2
          DATABASE_URL: postgresql+psycopg://daily2:daily2@localhost:5432/daily2_migrations
        run: |
          psql -h localhost -U daily2 -d daily2_test -c "CREATE DATABASE daily2_migrations"
          uv run alembic upgrade head
          uv run alembic check
          uv run alembic downgrade base
          uv run alembic upgrade head
          uv run alembic check

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v10
        with:
          python-version: "3.14"
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: The API snapshot matches the backend
        run: |
          frontend/scripts/snapshot-api.sh
          git diff --exit-code frontend/openapi.json frontend/src/testing/schemas.json frontend/src/app/core/api/openapi.ts
      - name: Prettier and unit tests (the image's test stage)
        run: docker build --target test frontend

  e2e:
    runs-on: ubuntu-latest
    needs: [backend, frontend]
    steps:
      - uses: actions/checkout@v7
      - uses: astral-sh/setup-uv@v10
        with:
          python-version: "3.14"
      - run: docker compose --profile ui up -d --build --wait
      - run: uv run --project backend python e2e/scenario.py
      - run: uv run --project backend python e2e/ui_smoke.py
      - if: failure()
        run: docker compose --profile ui logs
```

Before committing, compare with the file on the base branch and keep any backend change
made since this plan was written; check the current majors
(`gh api repos/actions/setup-node/releases/latest -q .tag_name` and the same for
`actions/checkout` and `astral-sh/setup-uv`).

The snapshot step proves the frontend was built against the current backend contract: a
backend change without `npm run api` fails CI.

- [ ] **Step 6: README**

In `README.md`, add under the design link:

```markdown
- Frontend plan: `docs/superpowers/plans/2026-09-30-core-frontend.md`
```

Insert before `## Local stack and E2E`:

```markdown
## Frontend

Angular PWA in `frontend/`: standalone components, signals, no zone.js. Screens live in
`src/app/features/`; `src/app/shared/` holds the form renderer that builds every form from
`GET /api/v2/schemas`, the timeline (Today, Day and Diary) and the gauge; `src/app/core/`
holds the typed API client, the one error-to-text mapping and the PKCE login.

    cd frontend
    npm ci
    npm start          # http://localhost:4200; proxies /api to the backend on 18100
    npm test           # Vitest with jsdom, no browser needed
    npm run lint       # prettier --check
    npm run api        # after a backend change: openapi.json, the schema snapshot and the types
    docker build --target test .   # lint and tests as CI runs them

The image is nginx: it serves the app, proxies `/api/` and `/health` to `BACKEND_URL`, and
writes `assets/runtime-config.json` from `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`
and `API_BASE` when it starts, so the same image runs locally and in the homelab.
```

Replace the command block of `## Local stack and E2E` with:

```markdown
    docker stop daily2-testdb                        # compose's db uses the same port
    docker compose --profile ui up -d --build --wait # Postgres 55433, Keycloak 18180 (admin/admin, dev-only), backend 18100, UI 18101
    uv run --project backend python e2e/scenario.py
    uv run --project backend python e2e/ui_smoke.py
    docker compose --profile ui down -v && docker start daily2-testdb
```

- [ ] **Step 7: Spec**

In `docs/superpowers/specs/2026-09-29-daily2-core-design.md`:

§8, after the `/profile` row of the route table, add:

```markdown
| `/log/:kind` | a new entry of one kind, opened from Today's "+" |
| `/callback` | finishes the Keycloak login (authorization code with PKCE) |
```

§8, after the Shared components bullet, add:

```markdown
- **Refresh:** every view reloads in place after a successful command; the UI keeps no
  cache of its own.
- **Login:** a small own PKCE implementation in `core/auth`; tokens live in
  `localStorage` so the PWA survives restarts.
```

§11, replace

```markdown
| Frontend (Karma) | the form renderer for each payload schema; diary cursor paging; gauge rendering |
```

with

```markdown
| Frontend (Vitest with jsdom, Angular's default runner, in the image's `test` stage) | the form renderer for each payload schema; diary cursor paging; gauge rendering; every screen |
| UI smoke (compose) | the container serves the app, `/healthz` and `assets/runtime-config.json` without inline scripts, proxies `/api` and `/health`, and Keycloak accepts the app's PKCE login, refresh and logout |
```

and replace

```markdown
| CI | ruff, pytest, Karma, Alembic upgrade/downgrade/upgrade with `alembic check`, E2E |
```

with

```markdown
| CI | ruff, pytest, Alembic upgrade/downgrade/upgrade with `alembic check`, the frontend API-snapshot check, Prettier and Vitest, E2E and the UI smoke |
```

In the spec's header line, replace `amended with the backend plan (#3)` with
`amended with the backend plan (#3) and the frontend implementation (#<issue>)`.

- [ ] **Step 8: Commit, push and open the PR**

```bash
git add frontend e2e/ui_smoke.py docker-compose.yml .github/workflows/ci.yml README.md docs/superpowers/specs
git commit -m "feat(frontend): nginx image with runtime config, compose profile, CI and UI smoke check

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin HEAD
```

Open the PR with `Closes #<issue>` and paste into its body the output of
`npm run lint && npm test` (Test Files 26, Tests 98), `docker build --target test frontend`,
`e2e/scenario.py` and `e2e/ui_smoke.py`, plus the notes from Step 4. Wait for CI
(`backend`, `frontend`, `e2e`) to be green before the squash merge.

---

## Done when (spec §12, frontend part)

- Every event kind can be logged, corrected, retracted and linked in the UI (Tasks 7 and 10;
  spec §12.1 together with the backend).
- Today with the four gauges, Diary, Day, Event, Catalog and Profile work on a phone-sized
  screen (Step 4 of Task 13), and gym-bro's sync status and "Sync now" show in Profile.
- `npm run lint`, `npm test` (98 tests), `docker build --target test frontend`,
  `e2e/scenario.py` and `e2e/ui_smoke.py` pass, and CI is green on the PR.
- The API snapshot in `frontend/` matches the backend (CI step).
- README and spec describe the frontend as built; the PR body carries the command outputs.

Plan 3 (homelab) takes the `prod` image and sets `BACKEND_URL`, `KEYCLOAK_URL`
(`https://…` of the homelab Keycloak), `KEYCLOAK_REALM` and `KEYCLOAK_CLIENT_ID`; the
homelab `daily2-app` client needs the redirect URI `https://daily2.home.example.com/*`,
web origin `+`, PKCE S256 and `post.logout.redirect.uris` `+`.
