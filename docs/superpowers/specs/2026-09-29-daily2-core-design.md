# daily 2.0: architecture and sub-project 1 (Core), design spec

Date: 2026-09-29 · Status: approved; amended with the backend plan (#3) and the frontend implementation (#9) · Issue: #1

## 1. Purpose

daily is Philipp's personal health system. It has three pillars:

1. **Track the body:** intake, outtake, medication, supplements, movement, workouts, sleep,
   body measurements, symptoms and how he feels.
2. **Diet autopilot:** planning, stock, shopping and later ordering happen on their own, so
   Philipp only cooks.
3. **Check the body:** is the diet goal working, and what causes health issues (above all
   digestion)?

The system is **operated by Claude** through MCP and **viewed by a human** in a PWA. The
PWA can still edit everything. gym-bro (workouts) and, later, the owner's own Colmi R09
ring software are external sources that daily syncs from.

daily 2.0 is a rebuild. v1 (`PhilippTheServer/daily-v1`, archived) was the prototype: table-shaped
storage with derived state patched in place, about 45 CRUD-shaped MCP tools, and one
dependency module of 1400 lines. v2 takes over only two UI ideas from it: the diary
timeline and the four gauges (kcal, protein, carbs, fat). **v2 does not depend on v1 data
or v1 concepts.** If v1 data does not fit the v2 model cleanly, it is left behind.

## 2. Principles

1. **Facts are append-only; everything else is derived.** What happened is stored as an
   event and is never overwritten or deleted. A correction is a new event, and a deletion
   is a retraction. Day summaries, gauges, stock and shopping lists are computed from the
   facts.
2. **One command layer.** Every write, whether from the UI, Claude or an integration, is a
   named command with a JSON Schema. REST and MCP are thin adapters over the same
   commands and queries. The UI and Claude can do exactly the same things.
3. **Every write tells the caller what changed** (`effects`), so the next step is
   obvious without another read.
4. **Modules own their data.** A module reaches another module only through its commands
   and queries, never through its tables.
5. **Pure domain logic.** Calculations such as summaries, targets, correction chains and
   later planning and simulation are pure functions, tested without a database.
6. **External sources are adapters.** An adapter fetches and maps data. The generic
   runner writes, deduplicates and records the sync status.

## 3. The closed loop and sub-projects

```
Goal → Targets → Plan → Requirements → Shortfall (Requirements − Stock) → Order
  ↑                                                                        ↓
Adjust ← Evaluate ← Day summary ← Intake ← Eat portion ← Cook batch ← Stock ← Delivery
```

| # | Sub-project | Adds |
|---|---|---|
| 1 | **Core** (this spec) | journal, catalog, profile and targets, the integration runner with the gym-bro adapter, Today, Diary, Day, Catalog and Profile views, MCP and REST |
| 2 | Kitchen | inventory ledger (purchase, consume, cook, discard, correct), cooking turns ingredients into portions with expiry, Kitchen view |
| 3 | Plan | meal slots and batches, `propose_plan` → `commit_plan` checked against targets and stock, adaptive energy model |
| 4 | Procurement and agenda | shopping list, orders, price observations, agenda items, web push |
| 5 | Integrations | Health Connect or iOS Shortcuts (steps, sleep, weight), Colmi R09 ring software, Picnic ordering |
| 6 | Insights | symptom ↔ food analysis, weight forecast, adherence |

Each sub-project gets its own spec, plan and release. Sub-projects 2–6 add new modules and
extend `get_context`. They do not change the tables of existing modules.

## 4. Core data model

### 4.1 Journal

```
event
  id               uuid pk
  chain_id         uuid        -- id of the first event of its correction chain (= id for an original)
  supersedes       uuid null   -- the event this one corrects (must be the chain head)
  kind             text        -- see 4.2
  schema_version   int         -- payload schema version for this kind
  occurred_at      timestamptz -- the moment, or the start
  ends_at          timestamptz null
  local_day        date        -- occurred_at's date in the profile timezone valid at occurred_at; fixed at write
  payload          jsonb       -- validated against the kind's schema
  source           text        -- app | claude | gym-bro | ring | health-connect | import
  external_source  text null
  external_id      text null   -- unique together with external_source on chain roots
  content_hash     text null   -- adapters: detects changes at the source
  recorded_at      timestamptz default now()
  retracted_at     timestamptz null   -- set on the chain head; the whole chain stops counting
  retract_reason   text null

event_link
  from_chain  uuid  -- links point at chains, so corrections keep their links
  to_chain    uuid
  relation    text  -- suspected_cause | part_of | follows
  created_at  timestamptz
  unique (from_chain, to_chain, relation)

command_log
  idempotency_key  text pk
  command          text
  response         jsonb
  created_at       timestamptz
```

**Chain rules**

- The **head** of a chain is its event that no other event supersedes.
- A chain counts in views when its head has `retracted_at` null.
- `correct_event(id)` requires `id` to be the head. Otherwise it answers **409
  `stale_head`**.
- Payloads are upgraded on read. A pure upcaster per kind lifts old `schema_version`
  payloads to the current version, and stored rows are never rewritten.

### 4.2 Event kinds and payloads (schema_version 1)

| kind | payload | time |
|---|---|---|
| `intake` | `{slot: breakfast\|lunch\|dinner\|snack\|null, items: [{food_id, food_version_id, grams, nutrients}], recipe_version_id?, portions?: float, note?}`. `nutrients` is snapshotted per item: kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, salt_g, fluid_ml. A drink is an intake whose foods have `kind: drink`, and `fluid_ml` = grams for drinks. | occurred_at |
| `outtake` | `{bristol: 1..7, urgency?: bool, pain?: 0..5, flags?: [blood, mucus, undigested], note?}` | occurred_at |
| `symptom` | `{type: stomach_ache\|gas\|bloated\|nausea\|diarrhea\|constipation\|heartburn\|headache\|fatigue\|skin\|other, severity: 1..5, body_area?, note?}` | occurred_at, ends_at? |
| `medication` | `{name, dose, unit, reason?, note?}` | occurred_at |
| `supplement` | `{name, dose, unit, note?}` | occurred_at |
| `sleep` | `{quality?: 1..5, stages?: {deep_min, light_min, rem_min, awake_min}, efficiency_pct?, note?}` | occurred_at = asleep, ends_at = awake |
| `activity` | `{steps?, active_minutes?, distance_km?}`, a day total | occurred_at = local day start, ends_at = day end |
| `workout` | `{title, category: strength\|cardio\|mixed\|other, set_count?, volume_kg?, exercises?: [{name, category, sets: [{reps?, weight_kg?, duration_s?, rpe?}]}]}` | occurred_at, ends_at |
| `measurement` | `{metric, value, unit}`. `metric` is an open vocabulary validated against a registry: `weight_kg, waist_cm, body_fat_pct, resting_hr_bpm, hrv_ms, spo2_pct, skin_temp_delta_c, blood_pressure_sys, blood_pressure_dia` | occurred_at |
| `checkin` | `{overall: 1..5, energy?: 1..5, mood?: 1..5, stress?: 1..5, note?}` | occurred_at |
| `note` | `{text}` | occurred_at |

Adding a kind means adding a payload schema, an upcaster entry and a timeline rendering
hint. It needs no migration.

### 4.3 Catalog

```
food          id, name, brand?, barcode?, kind: food|drink, source: off|manual,
              unit_name?, unit_grams?, pack_grams?, created_at, archived_at?
food_version  id, food_id, nutrients_per_100 (kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, salt_g),
              valid_from, source_note?
recipe        id, name, created_at, archived_at?
recipe_version id, recipe_id, serves, steps: [text], items: [{food_id, grams}], valid_from, note?
```

- Changing a food's nutrients or a recipe creates a new version. Intake events keep the
  version they were logged with.
- Name, unit and pack size are plain columns, because they don't change past nutrient
  maths.
- Foods and recipes are archived, never deleted.
- Open Food Facts lookups are cached as `food` rows with `source: off`.

### 4.4 Profile, goal and targets

```
profile_version  id, valid_from, height_cm, birth_date, sex, timezone,
                 goal_weight_kg?, goal_date?, protein_g_per_kg (default 1.8),
                 fat_g_per_kg_min (default 0.8), gym_sessions_per_week?
source_preference  metric, sources: [text]   -- e.g. steps: [ring, health-connect, app]
```

Core targets are pure (`profile/domain/targets.py`) and are **replaced by the adaptive
model in sub-project 3**:

- **Weight:** the latest `weight_kg` measurement on or before the day.
- **Maintenance:** Mifflin-St Jeor × 1.2, plus steps × weight × 0.0004, plus per workout
  (MET − 1) × weight × hours. MET is 7.0 for cardio and 5.0 otherwise.
- **Daily adjustment:** while `goal_date` is ahead and the goal is not reached, the
  adjustment is (goal − weight) × 7700 / days left, **clamped to ±750 kcal**. When the
  clamp applies, the result carries a warning: "goal date not reachable at a safe pace".
- **kcal target:** maintenance + adjustment.
- **Protein:** `protein_g_per_kg` × weight.
- **Fat:** max(`fat_g_per_kg_min` × weight, 25 % of the kcal target) / 9.
- **Carbs:** what is left / 4, floored at 0.
- **Missing inputs:** the targets are null and name the missing inputs.

### 4.5 Day summary (pure projection)

For a `local_day`, over counting chain heads:

- `nutrients`: the sum of the intake item snapshots
- `fluid_ml`
- `sleep`: the sleep event whose `ends_at` falls on the day
- `steps`: from the preferred source
- `weight_kg`
- `workouts`: count and minutes
- `symptoms`: per type, count and maximum severity
- `outtake_count`
- `energy`: the maintenance parts
- `targets`
- `gauges`: four `{value, target, ratio}` for kcal, protein, carbs and fat

## 5. Integrations

```
integrations/adapters.py  class SourceAdapter(Protocol):
                              name: str
                              interval_seconds: int
                              authoritative: bool
                              async def fetch(cursor: str | None, now) -> FetchResult
                          FetchResult: drafts, next cursor, covered_since, invalid, seen_ids
integrations/functions.py run_adapter: fetch, Postgres advisory lock, apply, sync_state bookkeeping
sync_state              source pk, cursor, last_attempt_at, last_success_at, last_error
```

**The runner** (`run_adapter` in `integrations/functions.py`) handles each `EventDraft {external_id, content_hash, kind, occurred_at,
ends_at?, payload}`:

- no chain with that `external_id` → create it
- the hash changed → `correct_event` on the head
- the hash is equal → skip

If the adapter is `authoritative`, chains from that source since `covered_since` (the start
of the span the fetch fully covers) that the fetch did not return are retracted with the
reason `removed at source`. The fetch also returns the next `cursor`; a run skipped because
another holds the advisory lock changes nothing, and a failed fetch changes no data and
records `last_error`.

**gym-bro adapter (Core).**
- Endpoint: `GET /api/v1/export/workouts?user_id&completed_after`.
- Auth: Keycloak client-credentials as a service account.
- Mapping: each session becomes one `workout` event.
- `authoritative`, window 14 days: the first run fetches everything (`covered_since` is the
  epoch); later runs fetch from the older of the cursor and now minus 14 days.

**Ring adapter (sub-project 5, not built).** The owner's own ring software will expose
`GET /export/daily-summaries?since=` with sleep sessions and day metrics.
- Each night becomes a `sleep` event with stages.
- Each day becomes an `activity` event plus `measurement` events for resting HR, HRV,
  SpO₂ and skin temperature.
- Raw samples stay in the ring software.
- Core already has the optional sleep fields, the open measurement vocabulary and
  `source_preference`, so adding the ring means one adapter file and one config block.

## 6. Commands and queries

### 6.1 Commands

| Command | Input | Result |
|---|---|---|
| `log_events` | `events: [{kind, occurred_at, ends_at?, payload, links?: [{to_chain, relation}]}]` (1–50) | the created events |
| `correct_event` | `id, occurred_at?, ends_at?, payload?` | the new head |
| `retract_event` | `id, reason?` | the retracted head |
| `link_events` / `unlink_events` | `from_chain, to_chain, relation` | the link |
| `import_food` | `barcode` or `off_code` | a food with its current version |
| `save_food` | `id?`, name, brand?, kind, unit?, pack?, nutrients? | a food. New nutrients create a new version. |
| `archive_food` | `id` | a food |
| `save_recipe` | `id?`, name, serves, steps, items | a recipe with a new version |
| `archive_recipe` | `id` | a recipe |
| `update_profile` | any profile field; only the fields sent change | the new profile version |
| `set_source_preference` | `metric, sources` | the preference |
| `sync_now` | `source` | the sync state |

**Every command:**
- accepts `idempotency_key?`, and a repeat returns the stored response from `command_log`
- runs in one transaction
- returns `{result, effects: {days: [date]}, warnings: [text]}`. Targets are never pushed
  as an effect; they are read through `get_context`, `get_day` or `get_profile`.

### 6.2 Queries

| Query | Returns |
|---|---|
| `get_context(date?)` | day summary with gauges; that day's timeline; weight and 14-day trend; symptoms of the last 3 days with their links; integration status; warnings (e.g. no weight for 7 days, no intake logged by 14:00). Later sub-projects add sections here. |
| `get_day(date)` | summary and timeline |
| `get_diary(cursor?, days 1–31 = 7, kinds?)` | whole days descending (a day is never split), events ascending within a day, `next_cursor` |
| `query_events(kinds?, from, to, filter?)` | heads with links; the range is at most 366 days |
| `get_event_history(chain_id)` | every version of a chain |
| `find_food(query)` | local foods first, then Open Food Facts hits (not yet imported) |
| `get_food(id)` / `get_recipe(id)` / `list_recipes()` | the current version; a recipe includes its totals per portion |
| `get_profile()` | the current profile, today's targets, source preferences and integration status |
| `get_schemas()` | JSON Schemas for all commands and payload kinds |

## 7. Interfaces

### 7.1 MCP

- **Transport and auth:** streamable HTTP at `/mcp` with OAuth protected-resource
  metadata. The metadata advertises `scopes_supported: ["openid"]`, which is the v1
  lesson for claude.ai authorization.
- **Clients:** one confidential client is the only accepted client for MCP
  (`MCP_CLIENT_ID`: `daily2-mcp` in the dev realm, `daily-mcp` in the homelab since the
  switch-over, §10).
- **Tools:** one tool per command and query in §6, 24 in total.
- **Tool descriptions** say when to use a tool. `get_context` is described as the first
  call of every conversation.
- **Resources:** payload schemas are also served as resources at
  `daily://schema/{kind}`.
- **Errors:** errors come back as `isError` with the §7.3 body as text.

### 7.2 REST (`/api/v2`)

| Route | Purpose |
|---|---|
| `GET /views/today?date=` | `get_context` |
| `GET /views/day?date=` | `get_day` |
| `GET /views/diary?cursor=&days=&kinds=` | `get_diary` |
| `GET /views/event?chain_id=` | `get_event_history` |
| `GET /views/catalog?q=` · `/views/food?id=` · `/views/recipe?id=` · `/views/recipes` | Catalog screens |
| `GET /views/profile` | `get_profile` (includes integration status) |
| `POST /commands/{command}` | any §6.1 command; the body is the command input |
| `GET /schemas` | `get_schemas()` |

Views take query parameters only. They are shaped for their screen and fully calculated, so the UI does no nutrient
maths or aggregation. The UI uses one public PKCE client (`APP_CLIENT_ID`: `daily2-app` in
the dev realm, `daily-app` in the homelab since the switch-over, §10).

### 7.3 Cross-cutting

- **Errors:** every error has the body `{code, message, field?}`. The codes are
  `validation` 422, `not_found` 404, `conflict` 409, `stale_head` 409, `unauthorized`
  401, `forbidden` 403, `upstream` 503 and `internal` 500. Arguments that fail an MCP
  tool's input schema are rejected by the MCP SDK itself, with its own validation text.
- **Source:** `source` is derived from the token's `azp`, never taken from the body.
- **Single owner:** the owner is the Keycloak subject `OWNER_SUB`. Any other subject gets
  403.
- **Time:** every timestamp needs an offset. Values are stored and returned in UTC, and
  every event also carries `local_day`.

## 8. Frontend

Angular (latest stable), standalone components, signals, a PWA and mobile-first.

| Route | Screen |
|---|---|
| `/today` | the **4 gauges**, today's timeline, warnings, a "+" entry picker |
| `/diary` | a continuous timeline: each entry is a timestamp row, one below the other across days, and older days load via the cursor. Tap an entry for its detail. |
| `/day/:date` | gauges and timeline for one date |
| `/event/:chain` | the payload, links, history ("corrected by claude at 14:02") and actions: edit, retract, link |
| `/catalog`, `/catalog/food/:id`, `/catalog/recipe/:id` | search, detail with versions, edit |
| `/profile` | body data, goal, targets with their derivation, source preferences, integration status |
| `/log/:kind` | a new entry of one kind, opened from Today's "+" |
| `/callback` | finishes the Keycloak login (authorization code with PKCE) |
| `/signed-out` | unguarded stop page shown when the API keeps refusing a fresh login; a button starts a new sign-in instead of redirecting in a loop |

- **Forms:** all create and edit forms come from `GET /schemas` through a small renderer
  in `shared/forms`. It supports number, integer, string, text, boolean, enum, multi-enum
  (a checkbox group), date-time, date, nested objects, arrays of objects and one custom
  widget, the food picker. No form library is used.
- **Shared components:** `shared/timeline` (used by Today, Day and Diary) and
  `shared/gauge`.
- **Refresh:** every view reloads in place after a successful command; the UI keeps no
  cache of its own.
- **Login:** a small own PKCE implementation in `core/auth`; tokens live in
  `localStorage` so the PWA survives restarts.

## 9. Repository and code layout

The backend follows the owner's structure:

- **`app/helpers/`** is one helper library for everything universal: config, logging,
  time, errors, command responses, universal data models, database, idempotency, the
  service registry, Keycloak auth, the operation machinery, and MCP.
- **`app/main.py`** only binds routers.
- **`app/health.py`** serves `GET /health`: version, uptime and database reachability.
- **`app/features/<name>/`** holds one mini API per feature:
  - `<name>.py`: its main, building the `FeatureApi`
  - `routers.py`: endpoints only
  - `functions.py`: the logic
  - `models.py`: tables and the feature's own models
  - `exceptions.py`: every error, declared on its operations
  - `services.py`: external clients, only where needed

An operation is declared once and served as a REST route, an MCP tool, OpenAPI error docs
and a JSON Schema.

```
backend/app/
  main.py · health.py
  helpers/        config · time · logging · errors · responses · models · database · idempotency
                  services · auth · endpoints · mcp · lifespan
  features/
    profile/      profile.py routers.py functions.py models.py exceptions.py
    catalog/      catalog.py routers.py functions.py models.py exceptions.py services.py
    journal/      journal.py routers.py functions.py models.py exceptions.py payloads.py
    days/         days.py routers.py functions.py calculations.py models.py exceptions.py
    integrations/ integrations.py routers.py functions.py models.py exceptions.py services.py adapters.py
backend/tests/    helpers/ · features/<name>/ · contracts/ ; e2e/scenario.py at repo root
frontend/src/app/ features/{today,diary,day,event,catalog,profile} · shared/{forms,timeline,gauge} · core/{api,auth}
docs/superpowers/ specs/ · plans/
```

- **Feature boundaries:** a feature reaches another feature only through its
  `functions.py` and `models.py`, never through its tables. `get_profile` lives in
  `days`, because it composes the profile, the journal and integration status.
- **Stack:** Python 3.14, uv, FastAPI, SQLAlchemy 2 (async) with psycopg, Alembic,
  Pydantic 2 and the official MCP Python SDK. ruff for linting and formatting, pytest for
  tests. Every package is at its latest stable version when the plan is written.

## 10. Deployment

- **Where:** the homelab repo gets a new Ansible role `daily2` modelled on `daily`. It
  has its own Postgres, images built on the mini PC and pushed to Harbor, and runs
  behind Traefik.
- **Hosts:** `daily.home.example.com` and
  `daily-mcp.example.com` (public, for the claude.ai connector). During the
  parallel run v2 served `daily2.home.…` and `daily2-mcp.…`, which are gone.
- **Keycloak clients:** v1's `daily-app` (public, PKCE) and `daily-mcp` (confidential).
  v2 took them over at the switch-over, together with the host and the audience
  `https://daily-mcp.example.com/mcp`, so the claude.ai connector kept its
  refresh token and did not have to sign in again. The parallel run's `daily2-app` and
  `daily2-mcp` are deleted. The gym-bro sync signs in as v1's `daily-gymbro-sync`,
  because gym-bro's `EXPORT_CLIENT_ID` accepts exactly one client.
- **Secrets:** Vault `secret/ansible`: `vault_daily2_db_password`, and v1's
  `vault_daily_mcp_oidc_secret` and `vault_daily_gymbro_sync_secret`.
- **Parallel run (ended 2026-09-30):** v1 ran unchanged next to v2.

**Switch-over** happens after the §12 criteria are met:

1. The hostnames `daily.*` move to v2. Done on 2026-09-30 (homelab #192).
2. The v1 role is removed. Done on 2026-09-30 (homelab #192). v1's `daily_db` volume
   is kept on the mini PC.
3. The repo `daily` is renamed to `daily-v1` and archived. Done on 2026-09-30.
4. `daily2` is renamed to `daily`. Done on 2026-09-30; GitHub redirects the old name.

## 11. Testing

| Level | Covers |
|---|---|
| Domain (no DB) | each payload schema (valid and invalid cases), upcasters, chain head resolution, day summary, gauges, targets (including the clamp and fat floor), `local_day` across a timezone change |
| Commands (Postgres) | idempotent replay, `stale_head` 409, retract excludes a chain, links survive corrections, adapter create, correct, skip and retract |
| Contracts | exact MCP tool list; every declared error (and 409 on every command) documented in OpenAPI; REST shape follows the operation kind (no OpenAPI snapshot); REST/MCP parity: every payload kind logged through MCP and through REST gives identical `get_day` output |
| Frontend (Vitest with jsdom, Angular's default runner, in the image's `test` stage) | the form renderer for each payload schema; diary cursor paging; gauge rendering; every screen |
| UI smoke (compose) | the container serves the app, `/healthz` and `assets/runtime-config.json` without inline scripts, proxies `/api` and `/health`, and Keycloak accepts the app's PKCE login, refresh and logout |
| E2E (compose, real Keycloak) | `get_context` → log breakfast → log a symptom linked to it → correct the breakfast → the diary shows the corrected head and `get_event_history` shows both versions → retract the symptom → the day summary drops it |
| CI | ruff, pytest, Alembic upgrade/downgrade/upgrade with `alembic check`, the frontend API-snapshot check, Prettier and Vitest, E2E and the UI smoke |

## 12. Core is done when

1. Every kind in §4.2 can be logged, corrected, retracted and linked through both MCP
   and the UI.
2. Today (with the 4 gauges), Diary, Day, Event, Catalog and Profile work on a phone.
3. The gym-bro adapter syncs, and its status shows in Profile and in `get_context`.
4. `get_context` gives Claude the whole day in one call.
5. The E2E scenario and CI are green, and v2 is deployed next to v1.

## 13. Out of scope for Core

- Kitchen, Plan, Procurement, agenda and notifications, Insights (sub-projects 2–4
  and 6).
- The ring, Health Connect and Picnic adapters (sub-project 5).
- A v1 importer. It would be an optional, separate one-way tool for foods and recipes
  only, decided at switch-over. v2's schema never accommodates v1 shapes.
- Multi-user support.
