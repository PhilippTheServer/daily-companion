# daily 2.0

Agent-operated, human-viewed health and diet system: an event journal, a versioned food
catalog, profile and targets, day views, and integrations, served as REST for the PWA and
MCP for Claude.

- Design: `docs/superpowers/specs/2026-09-29-daily2-core-design.md`
- Backend plan: `docs/superpowers/plans/2026-09-29-core-backend.md`
- Frontend plan: `docs/superpowers/plans/2026-09-30-core-frontend.md`

## Backend

Structure: `app/helpers/` is the one helper library (config, logging, time, errors,
responses, universal models, database, idempotency, services, Keycloak, operations → REST
and MCP). `app/main.py` only binds routers, and `app/health.py` serves `GET /health`.
Each feature in `app/features/<name>/` is a mini API: `<name>.py` (its main),
`routers.py` (endpoints only), `functions.py` (logic), `models.py`, `exceptions.py`
(every error, declared on its operations) and, if needed, `services.py`. An operation is
declared once and served as `POST /api/v2/commands/{name}` or `GET /api/v2/views/{view}`
and as an MCP tool at `/mcp`.

    cd backend
    uv sync
    docker run -d --name daily2-testdb -e POSTGRES_USER=daily2 -e POSTGRES_PASSWORD=daily2 \
      -e POSTGRES_DB=daily2_test -p 55433:5432 postgres:18-alpine
    TEST_DATABASE_URL=postgresql+psycopg://daily2:daily2@localhost:55433/daily2_test uv run pytest -q
    uv run ruff check && uv run ruff format --check

Tests without `TEST_DATABASE_URL` skip the database parts.

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

The image is nginx on port 80: it serves the app, proxies `/api/` and `/health` to
`BACKEND_URL` (default `http://backend:8000`, no path, no trailing slash), and writes
`assets/runtime-config.json` (built with `jq`, so values are JSON-escaped) from `KEYCLOAK_URL`,
`KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID` and `API_BASE` when it starts, so the same image runs
locally and in the homelab. It refuses to start when one of them is empty. The backend name
is re-resolved through Docker's DNS (10 s), so recreating the backend needs no frontend
restart. `/mcp` is not proxied. `index.html`, `ngsw.json`, the service worker files and
`runtime-config.json` are served `no-cache`; hashed scripts and styles are cached long.

The Content-Security-Policy is `default-src 'self'; connect-src 'self' <Keycloak origin>;
style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
The Keycloak origin (scheme, host and port of `KEYCLOAK_URL`) is derived at start, and a trailing
`/` on `KEYCLOAK_URL` is removed.

The installed PWA needs the network to start: `assets/runtime-config.json` is served `no-cache`
and is not in the service worker's cache, so the app cannot boot offline.

Container decisions: the image runs nginx as root and listens on port 80. That is accepted:
port 80 is the contract with the Traefik-based deploy, which terminates TLS in front. The
proxy passes `X-Forwarded-Proto` from Traefik (falling back to its own scheme) and appends to
`X-Forwarded-For`; that is safe only because Traefik is the sole client on a private network.

## Local stack and E2E

    docker stop daily2-testdb                        # compose's db uses the same port
    docker compose --profile ui up -d --build --wait # Postgres 55433, Keycloak 18180 (admin/admin, dev-only), backend 18100, UI 18101
    uv run --project backend python e2e/scenario.py
    uv run --project backend python e2e/ui_smoke.py
    docker compose --profile ui down -v && docker start daily2-testdb

The dev realm `daily2` has one user `dev`/`dev` (id `11111111-…`, the owner) and three
clients: `daily2-app` (public), `daily2-mcp` (secret `dev-mcp-secret`) and
`daily2-gymbro-sync` (secret `dev-sync-secret`). Every one of these credentials is
dev-only.

Deploy note: the container runs one uvicorn worker by default (`WORKERS=1`); every worker
starts its own sync loop, so more than one races on the first `SyncState` insert.
