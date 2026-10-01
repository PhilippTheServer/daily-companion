# daily 2.0 Core backend: implementation plan (plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Core backend of daily 2.0 (spec
`docs/superpowers/specs/2026-09-29-daily2-core-design.md`): an event journal, a versioned
catalog, profile and targets, day projections, and a gym-bro integration. It is served as
REST for the UI and MCP for Claude from one definition per operation.

**Architecture:** There is one helper library, `app/helpers/`, holding everything
universal: config, logging, time, errors, responses, universal data models, the database,
idempotency, services, Keycloak auth, the operation and endpoint machinery, and MCP. Each
feature under `app/features/<name>/` is a mini API:

- `<name>.py`: its main, which builds the `FeatureApi`
- `routers.py`: endpoint declarations only
- `functions.py`: the logic
- `models.py`: ORM tables and the feature's own input/output models
- `exceptions.py`: every error the feature raises, declared on its operations
- `services.py` (optional): external HTTP clients

An operation is declared once, as an `Operation` in `routers.py`. The helpers turn it into
a REST route, an MCP tool, OpenAPI error docs and a JSON Schema. `app/main.py` only binds
routers, and `app/health.py` serves `/health`.

**Tech Stack:** Python 3.14, uv, FastAPI, Pydantic 2, SQLAlchemy 2 (async) with psycopg 3,
Alembic, the MCP Python SDK (`mcp.server.mcpserver.MCPServer`), httpx, PyJWT, pytest with
pytest-asyncio, and ruff.

**Plans:** 1 = Core backend (this file). 2 = Core frontend (Angular PWA). 3 = homelab
deploy (Ansible role `daily2`, Keycloak clients, and the gym-bro export client). Plans 2
and 3 are written after this one is merged.

## Global Constraints

- Python `>=3.14`. Use `uv` only and never `pip`. Every dependency is at its latest stable
  version at implementation time, installed with `uv add` and never hand-pinned.
- `uv run ruff check` and `uv run ruff format --check` must pass in `backend/` at every
  commit.
- No inline comments unless the *why* is non-obvious. Every module, class and public
  function gets a one-to-three-line docstring.
- No code is written twice. When two features need the same thing, it lives in
  `app/helpers/`, or in the feature that owns the data, which exposes it through its
  `functions.py`.
- A feature reaches another feature only through that feature's `functions.py` and
  `models.py`. It never queries another feature's tables.
- Facts are append-only. An event is never updated except for the bookkeeping columns
  `is_head`, `retracted_at` and `retract_reason`. Foods and recipes change by adding
  versions.
- Every timestamp in an input needs a UTC offset. Timestamps are stored and returned in
  UTC, and every event also carries `local_day`.
- The error body is always `{"code", "message", "field"}`. The codes are `validation` 422,
  `not_found` 404, `conflict` 409, `stale_head` 409, `unauthorized` 401, `forbidden` 403,
  `upstream` 503 and `internal` 500.
- Single owner: only the Keycloak subject `OWNER_SUB` is accepted. REST accepts only the
  `daily2-app` client, and MCP accepts only `daily2-mcp` with the resource URL in `aud`.
- Local dev ports: Postgres `55433`, Keycloak `18180`, backend `18100`. These don't clash
  with v1 (55432, 18080, 18000) or gym-bro (5432, 8080, 8000).
- Never write a secret into a tracked file. The dev realm's throwaway credentials are
  marked `# dev-only`.
- Before Task 0, open the implementation issue ("feat: Core backend", linking this plan).
  `<issue>` in every commit message below is that issue's number. Every commit message
  ends with `Refs #<issue>` and the line
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- The code blocks here are not line-wrapped. Always run `uv run ruff format` before
  `uv run ruff check`. If E501 remains after formatting (a long string literal), split the
  string.

## File map

```
backend/
  pyproject.toml · uv.lock · alembic.ini · Dockerfile · docker-entrypoint.sh
  alembic/env.py · alembic/script.py.mako · alembic/versions/0001_core.py
  app/
    main.py                 binds routers (create_app + app)
    health.py               GET /health
    helpers/
      config.py             Settings, get_settings, app_version
      time.py               utcnow, to_utc, local_day, day_bounds, to_local
      logging.py            JsonFormatter, configure_logging, get_logger
      errors.py             AppError tree, ErrorBody, to_app_error, from_validation_errors
      responses.py          Effects, CommandResponse[T], Outcome[T], error_responses
      models.py             UtcDatetime, StrictModel, CommandInput, QueryInput, ById, ByIdCommand,
                            EmptyQuery, Nutrients, encode_cursor, decode_cursor
      database.py           Base, CreatedAtMixin, engine/session, open_session, override_session_provider,
                            try_advisory_xact_lock, ping, dispose_engine
      idempotency.py        CommandLog, replay, remember
      services.py           ServiceRegistry, services
      auth.py               TokenValidator, http_jwks_fetcher, get/override_token_validator, Principal,
                            SYSTEM, verify_access_token, rest_principal, McpTokenVerifier, mcp_principal,
                            ClientCredentials
      endpoints.py          Context, Operation, command, query, FeatureApi, execute, AppRoute,
                            schemas_api, fallback_router
      mcp.py                build_mcp_server, mcp_router
      lifespan.py           lifespan (logging, services close, engine dispose)
    features/
      profile/   profile.py routers.py functions.py models.py exceptions.py
      catalog/   catalog.py routers.py functions.py models.py exceptions.py services.py
      journal/   journal.py routers.py functions.py models.py exceptions.py payloads.py
      days/      days.py routers.py functions.py calculations.py models.py exceptions.py
      integrations/ integrations.py routers.py functions.py models.py exceptions.py services.py adapters.py
  tests/
    conftest.py · tokens.py · clients.py
    helpers/ · features/<name>/ · contracts/
docker-compose.yml · keycloak/realm-dev.json · e2e/scenario.py · .github/workflows/ci.yml · README.md
```

Two deliberate extras inside features, both still "data models" and "logic":
- `journal/payloads.py` holds the payload model of each event kind.
- `days/calculations.py` holds the pure maths (energy, targets, trend, summary), so
  `days/functions.py` stays about loading and composing.

---

### Task 0: Repository scaffold, spec amendment, CI skeleton

**Files:**
- Create: `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/helpers/__init__.py`, `backend/app/features/__init__.py`, `backend/tests/__init__.py`, `backend/tests/test_scaffold.py`, `.gitignore`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Produces: an installable package `daily2-backend` (import root `app`) and a CI workflow
  that later tasks extend.

- [ ] **Step 1: Create the project**

```bash
mkdir -p backend && cd backend
uv init --package --name daily2-backend --python 3.14 --no-readme .
rm -rf src
uv add fastapi "uvicorn[standard]" "sqlalchemy[asyncio]" "psycopg[binary]" alembic pydantic pydantic-settings httpx "pyjwt[crypto]" mcp
uv add --dev pytest pytest-asyncio ruff
```

Then replace the generated `[build-system]` and tool sections so `backend/pyproject.toml`
ends with exactly this. Keep the `[project]` dependency lines `uv add` wrote.

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["app"]

[tool.ruff]
line-length = 100
target-version = "py314"
extend-exclude = ["alembic/versions"]

[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "SIM"]
ignore = ["N818"]

[tool.ruff.format]
quote-style = "double"

[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
testpaths = ["tests"]
```

Create empty `app/__init__.py`, `app/helpers/__init__.py`, `app/features/__init__.py` and
`tests/__init__.py`. In `[project]`, set `version = "0.1.0"` and
`description = "daily 2.0 backend: journal, catalog, profile, days and integrations over REST and MCP"`.

- [ ] **Step 2: Write the scaffold test**

`backend/tests/test_scaffold.py`:

```python
from importlib.metadata import version


def test_package_is_installed():
    assert version("daily2-backend") == "0.1.0"
```

- [ ] **Step 3: Run it**

Run: `cd backend && uv run pytest -q`
Expected: `1 passed`

- [ ] **Step 4: Spec**

The spec was already amended for this layout in the plan's PR (#3). There is nothing to do
here; read §6, §7.2, §7.3 and §9 once before starting.

- [ ] **Step 5: `.gitignore`, README and the CI skeleton**

`.gitignore`:

```
__pycache__/
.venv/
.pytest_cache/
.ruff_cache/
*.egg-info/
.env
node_modules/
```

`README.md`:

```markdown
# daily 2.0

Agent-operated, human-viewed health and diet system: an event journal, a versioned food
catalog, profile and targets, day views, and integrations, served as REST for the PWA and
MCP for Claude.

- Design: `docs/superpowers/specs/2026-09-29-daily2-core-design.md`
- Backend plan: `docs/superpowers/plans/2026-09-29-core-backend.md`

## Backend

    cd backend
    uv sync
    uv run pytest -q
    uv run ruff check && uv run ruff format --check
```

`.github/workflows/ci.yml`:

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
    steps:
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v7
        with:
          python-version: "3.14"
      - run: uv sync --frozen
      - run: uv run ruff check
      - run: uv run ruff format --check
      - run: uv run pytest -q
```

Before committing, check the current major versions of `actions/checkout` and
`astral-sh/setup-uv` (`gh api repos/actions/checkout/releases/latest -q .tag_name`,
`gh api repos/astral-sh/setup-uv/releases/latest -q .tag_name`). Use the major of each.

- [ ] **Step 6: Lint and commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add .gitignore README.md .github backend
git commit -m "chore: scaffold the backend package and CI

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: Helpers for config, time and logging

**Files:**
- Create: `backend/app/helpers/config.py`, `backend/app/helpers/time.py`, `backend/app/helpers/logging.py`
- Test: `backend/tests/helpers/__init__.py`, `backend/tests/helpers/test_time.py`, `backend/tests/helpers/test_logging.py`

**Interfaces:**
- Produces:
  - `Settings` (fields below), `get_settings() -> Settings` (cached), `app_version() -> str`
  - `utcnow() -> datetime`, `to_utc(value: datetime) -> datetime` (raises `ValueError` on a naive value)
  - `local_day(moment: datetime, timezone: str) -> date`
  - `day_bounds(day: date, timezone: str) -> tuple[datetime, datetime]` (UTC, half-open)
  - `to_local(moment: datetime, timezone: str) -> datetime`
  - `JsonFormatter`, `configure_logging(level: str, as_json: bool) -> None`, `get_logger(name: str) -> logging.Logger`

- [ ] **Step 1: Write the failing tests**

`backend/tests/helpers/__init__.py`: empty.

`backend/tests/helpers/test_time.py`:

```python
from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from app.helpers.time import day_bounds, local_day, to_local, to_utc


def test_to_utc_converts_an_offset_timestamp():
    moment = datetime(2026, 9, 30, 8, 0, tzinfo=timezone(timedelta(hours=2)))
    assert to_utc(moment) == datetime(2026, 9, 30, 6, 0, tzinfo=UTC)


def test_to_utc_rejects_a_naive_timestamp():
    with pytest.raises(ValueError, match="UTC offset"):
        to_utc(datetime(2026, 9, 30, 8, 0))


def test_local_day_uses_the_timezone():
    late_utc = datetime(2026, 9, 30, 22, 30, tzinfo=UTC)
    assert local_day(late_utc, "Europe/Berlin") == date(2026, 10, 1)
    assert local_day(late_utc, "UTC") == date(2026, 9, 30)


def test_day_bounds_cover_a_dst_change():
    start, end = day_bounds(date(2026, 10, 25), "Europe/Berlin")
    assert start == datetime(2026, 10, 24, 22, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 25, 23, 0, tzinfo=UTC)
    assert end - start == timedelta(hours=25)


def test_to_local_keeps_the_instant():
    moment = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
    local = to_local(moment, "Europe/Berlin")
    assert local.hour == 14
    assert local == moment
```

`backend/tests/helpers/test_logging.py`:

```python
import json
import logging

from app.helpers.logging import JsonFormatter, get_logger


def test_json_formatter_emits_one_json_object():
    record = logging.LogRecord("daily2.test", logging.INFO, __file__, 1, "hello %s", ("you",), None)
    record.context = {"source": "gym-bro"}
    entry = json.loads(JsonFormatter().format(record))
    assert entry["level"] == "INFO"
    assert entry["logger"] == "daily2.test"
    assert entry["message"] == "hello you"
    assert entry["context"] == {"source": "gym-bro"}
    assert "ts" in entry


def test_get_logger_namespaces_under_daily2():
    assert get_logger("journal").name == "daily2.journal"
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/helpers -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.helpers.time'`

- [ ] **Step 3: Implement**

`backend/app/helpers/config.py`:

```python
"""Settings read from the environment, and the running version."""

from functools import lru_cache
from importlib.metadata import version

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Every setting the backend reads; the defaults match the local compose stack."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://daily2:daily2@localhost:55433/daily2"
    keycloak_url: str = "http://localhost:18180"
    keycloak_public_url: str = "http://localhost:18180"
    keycloak_realm: str = "daily2"
    app_client_id: str = "daily2-app"
    mcp_client_id: str = "daily2-mcp"
    owner_sub: str = ""
    mcp_resource_url: str = "http://localhost:18100/mcp"
    mcp_allowed_hosts: list[str] = ["localhost:18100", "127.0.0.1:18100"]
    mcp_allowed_origins: list[str] = ["https://claude.ai", "https://claude.com"]
    default_timezone: str = "Europe/Berlin"
    log_level: str = "INFO"
    log_json: bool = True
    off_search_url: str = "https://search.openfoodfacts.org/search"
    off_product_url: str = "https://world.openfoodfacts.org/api/v2/product"
    off_user_agent: str = "daily2 (+https://github.com/PhilippTheServer/daily2)"
    gym_bro_url: str = ""
    gym_bro_client_id: str = "daily2-gymbro-sync"
    gym_bro_client_secret: str = ""
    gym_bro_interval_seconds: int = 900

    @property
    def keycloak_issuer(self) -> str:
        """The `iss` every accepted token carries."""
        return f"{self.keycloak_public_url}/realms/{self.keycloak_realm}"

    @property
    def keycloak_jwks_uri(self) -> str:
        """Where the realm's signing keys are fetched from (internal URL)."""
        return f"{self.keycloak_url}/realms/{self.keycloak_realm}/protocol/openid-connect/certs"

    @property
    def keycloak_token_url(self) -> str:
        """The realm's token endpoint (internal URL), used for client credentials."""
        return f"{self.keycloak_url}/realms/{self.keycloak_realm}/protocol/openid-connect/token"


@lru_cache
def get_settings() -> Settings:
    """The process-wide settings, read once."""
    return Settings()


def app_version() -> str:
    """The installed package version."""
    return version("daily2-backend")
```

`backend/app/helpers/time.py`:

```python
"""Time helpers: everything is stored in UTC, and days are local to a timezone."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def utcnow() -> datetime:
    """The current instant in UTC."""
    return datetime.now(UTC)


def to_utc(value: datetime) -> datetime:
    """Convert an offset-aware timestamp to UTC; a naive one is rejected."""
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp needs a UTC offset")
    return value.astimezone(UTC)


def to_local(moment: datetime, timezone: str) -> datetime:
    """The same instant expressed in the given IANA timezone."""
    return to_utc(moment).astimezone(ZoneInfo(timezone))


def local_day(moment: datetime, timezone: str) -> date:
    """The calendar day of an instant in the given timezone."""
    return to_local(moment, timezone).date()


def day_bounds(day: date, timezone: str) -> tuple[datetime, datetime]:
    """The UTC start (inclusive) and end (exclusive) of a local day."""
    zone = ZoneInfo(timezone)
    start = datetime.combine(day, time.min, zone)
    end = datetime.combine(day + timedelta(days=1), time.min, zone)
    return start.astimezone(UTC), end.astimezone(UTC)
```

`backend/app/helpers/logging.py`:

```python
"""Logging: one JSON object per line in production, plain text for local work."""

import json
import logging
import sys

from app.helpers.time import utcnow


class JsonFormatter(logging.Formatter):
    """Formats a record as JSON; `record.context` (a dict) is carried along if present."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": utcnow().isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        context = getattr(record, "context", None)
        if context:
            entry["context"] = context
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def configure_logging(level: str, as_json: bool) -> None:
    """Route every logger to stdout at the given level."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter()
        if as_json
        else logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())


def get_logger(name: str) -> logging.Logger:
    """A logger under the `daily2.` namespace."""
    return logging.getLogger(f"daily2.{name}")
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/helpers -q`
Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(helpers): settings, time and logging

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Helpers for errors, responses and universal data models

**Files:**
- Create: `backend/app/helpers/errors.py`, `backend/app/helpers/responses.py`, `backend/app/helpers/models.py`
- Test: `backend/tests/helpers/test_errors.py`, `backend/tests/helpers/test_models.py`

**Interfaces:**
- Consumes: `get_logger`, `to_utc` (Task 1).
- Produces:
  - `ErrorBody(code: str, message: str, field: str | None)`
  - `AppError(message: str, field: str | None = None)` with class attributes `code` and
    `status`, and `.body() -> ErrorBody`. Subclasses: `ValidationFailed`, `NotFound`,
    `Conflict`, `Unauthorized`, `Forbidden`, `Upstream`, `Internal`.
  - `from_validation_errors(errors: list[dict], prefix: str = "") -> ValidationFailed`
  - `to_app_error(exc: BaseException) -> AppError`
  - `Effects(days: list[date])`, `CommandResponse[T](result: T, effects: Effects, warnings: list[str])`
  - `Outcome[T](result: T, days: set[date], warnings: list[str])` (dataclass)
  - `error_responses(errors: Iterable[type[AppError]]) -> dict[int, dict]`
  - `UtcDatetime`, `StrictModel`, `CommandInput(idempotency_key: str | None)`,
    `QueryInput`, `EmptyQuery`, `ById(id: UUID)`, `ByIdCommand(id: UUID)`
  - `Nutrients` (fields `kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, salt_g,
    fluid_ml`, all float defaulting to 0) with `.__add__`, `.scaled(factor)` and
    `Nutrients.total(items)`
  - `encode_cursor(data: dict) -> str`, `decode_cursor(cursor: str) -> dict` (raises
    `ValidationFailed`)

- [ ] **Step 1: Write the failing tests**

`backend/tests/helpers/test_errors.py`:

```python
import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy.exc import IntegrityError

from app.helpers.errors import (
    AppError,
    Conflict,
    ErrorBody,
    Internal,
    NotFound,
    ValidationFailed,
    from_validation_errors,
    to_app_error,
)
from app.helpers.responses import error_responses


class _Model(BaseModel):
    grams: int


def test_app_error_body_carries_code_message_and_field():
    error = NotFound("food not found", "food_id")
    assert (error.status, error.code) == (404, "not_found")
    assert error.body() == ErrorBody(code="not_found", message="food not found", field="food_id")


def test_validation_error_becomes_validation_failed_with_a_dotted_field():
    with pytest.raises(ValidationError) as caught:
        _Model.model_validate({"grams": "many"})
    error = to_app_error(caught.value)
    assert isinstance(error, ValidationFailed)
    assert error.field == "grams"


def test_prefix_is_prepended_to_the_field():
    error = from_validation_errors([{"loc": ("body", "grams"), "msg": "bad"}], prefix="events.0")
    assert error.field == "events.0.grams"
    assert error.message == "bad"


def test_integrity_error_becomes_a_generic_conflict():
    error = to_app_error(IntegrityError("stmt", {}, Exception("dup")))
    assert isinstance(error, Conflict)
    assert error.message == "conflicting data"


def test_unknown_exception_becomes_internal_without_leaking_its_text():
    error = to_app_error(RuntimeError("secret detail"))
    assert isinstance(error, Internal)
    assert error.message == "internal error"


def test_app_error_passes_through():
    original = Conflict("taken")
    assert to_app_error(original) is original


def test_error_responses_group_codes_by_status():
    class StaleHead(Conflict):
        code = "stale_head"

    responses = error_responses([NotFound, Conflict, StaleHead])
    assert responses[404]["model"] is ErrorBody
    assert responses[409]["description"] == "conflict, stale_head"


def test_base_class_is_internal():
    assert (AppError.status, AppError.code) == (500, "internal")
```

`backend/tests/helpers/test_models.py`:

```python
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.helpers.errors import ValidationFailed
from app.helpers.models import (
    CommandInput,
    Nutrients,
    StrictModel,
    UtcDatetime,
    decode_cursor,
    encode_cursor,
)


class _Stamped(StrictModel):
    at: UtcDatetime


def test_utc_datetime_normalises_and_requires_an_offset():
    assert _Stamped(at="2026-09-30T08:00:00+02:00").at == datetime(2026, 9, 30, 6, tzinfo=UTC)
    with pytest.raises(ValidationError):
        _Stamped(at="2026-09-30T08:00:00")


def test_strict_models_reject_unknown_fields():
    with pytest.raises(ValidationError):
        CommandInput(idempotency_key="k", surprise=1)


def test_nutrients_add_scale_and_total():
    a = Nutrients(kcal=100, protein_g=10)
    b = Nutrients(kcal=50.5, fat_g=2)
    assert (a + b).kcal == 150.5
    assert a.scaled(1.5).protein_g == 15
    assert Nutrients.total([a, b, a]).kcal == 250.5
    assert Nutrients.total([]) == Nutrients()


def test_cursor_round_trip_and_rejects_garbage():
    assert decode_cursor(encode_cursor({"before": "2026-09-30"})) == {"before": "2026-09-30"}
    with pytest.raises(ValidationFailed):
        decode_cursor("%%%not-base64")
    with pytest.raises(ValidationFailed):
        decode_cursor(encode_cursor([1, 2]))  # type: ignore[arg-type]
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/helpers/test_errors.py tests/helpers/test_models.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.helpers.errors'`

- [ ] **Step 3: Implement**

`backend/app/helpers/errors.py`:

```python
"""The one error model: every failure becomes an AppError with a code, status and body."""

from typing import Any, ClassVar

from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError
from sqlalchemy.exc import IntegrityError

from app.helpers.logging import get_logger

logger = get_logger("errors")

_LOCATION_PARTS = {"body", "query", "path", "header"}


class ErrorBody(BaseModel):
    """What REST returns as the response body and MCP returns as the error text."""

    code: str
    message: str
    field: str | None = None


class AppError(Exception):
    """Base of every anticipated failure; subclasses set `code` and `status`."""

    code: ClassVar[str] = "internal"
    status: ClassVar[int] = 500

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.field = field

    def body(self) -> ErrorBody:
        """The serialisable error body."""
        return ErrorBody(code=self.code, message=self.message, field=self.field)


class ValidationFailed(AppError):
    """Input is well-formed JSON but not acceptable."""

    code = "validation"
    status = 422


class NotFound(AppError):
    """A referenced entity does not exist."""

    code = "not_found"
    status = 404


class Conflict(AppError):
    """The request clashes with the current state."""

    code = "conflict"
    status = 409


class Unauthorized(AppError):
    """No valid bearer token."""

    code = "unauthorized"
    status = 401


class Forbidden(AppError):
    """A valid token, but not for this caller or client."""

    code = "forbidden"
    status = 403


class Upstream(AppError):
    """A service this backend depends on failed."""

    code = "upstream"
    status = 503


class Internal(AppError):
    """An unanticipated failure; the message never carries internals."""

    code = "internal"
    status = 500


def _field(location: Any, prefix: str) -> str | None:
    parts = [str(part) for part in location if str(part) not in _LOCATION_PARTS]
    if prefix:
        parts.insert(0, prefix)
    return ".".join(parts) or None


def from_validation_errors(errors: list[dict[str, Any]], prefix: str = "") -> ValidationFailed:
    """The first pydantic/FastAPI validation error as a ValidationFailed."""
    first = errors[0] if errors else {}
    return ValidationFailed(first.get("msg", "invalid input"), _field(first.get("loc", ()), prefix))


def to_app_error(exc: BaseException) -> AppError:
    """Map any exception to an AppError; unexpected ones are logged and hidden."""
    if isinstance(exc, AppError):
        return exc
    if isinstance(exc, RequestValidationError | ValidationError):
        return from_validation_errors(list(exc.errors()))
    if isinstance(exc, IntegrityError):
        return Conflict("conflicting data")
    logger.error("unexpected error", exc_info=exc)
    return Internal("internal error")
```

`backend/app/helpers/responses.py`:

```python
"""The shape every command answers with, and OpenAPI error docs."""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from pydantic import BaseModel, Field

from app.helpers.errors import AppError, ErrorBody


class Effects(BaseModel):
    """What a command changed that a caller may want to re-read."""

    days: list[date] = Field(default_factory=list)


class CommandResponse[T](BaseModel):
    """Every command's response: the result, its effects and any warnings."""

    result: T
    effects: Effects = Field(default_factory=Effects)
    warnings: list[str] = Field(default_factory=list)


@dataclass
class Outcome[T]:
    """What a command handler returns; the endpoint machinery turns it into a response."""

    result: T
    days: set[date] = field(default_factory=set)
    warnings: list[str] = field(default_factory=list)


def error_responses(errors: Iterable[type[AppError]]) -> dict[int | str, dict[str, Any]]:
    """OpenAPI `responses` documenting each error status and the codes behind it."""
    responses: dict[int | str, dict[str, Any]] = {}
    for error in errors:
        entry = responses.setdefault(error.status, {"model": ErrorBody, "description": ""})
        codes = [code for code in entry["description"].split(", ") if code]
        if error.code not in codes:
            codes.append(error.code)
        entry["description"] = ", ".join(codes)
    return responses
```

`backend/app/helpers/models.py`:

```python
"""Universal data models shared by every feature."""

import base64
import binascii
import json
import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.helpers.errors import ValidationFailed
from app.helpers.time import to_utc

UtcDatetime = Annotated[datetime, AfterValidator(to_utc)]


class StrictModel(BaseModel):
    """An input model that rejects unknown fields."""

    model_config = ConfigDict(extra="forbid")


class CommandInput(StrictModel):
    """Base of every command input; a repeated key replays the first response."""

    idempotency_key: str | None = Field(default=None, min_length=1, max_length=200)


class QueryInput(StrictModel):
    """Base of every query input."""


class EmptyQuery(QueryInput):
    """A query without parameters."""


class ById(QueryInput):
    """A query for one entity."""

    id: uuid.UUID


class ByIdCommand(CommandInput):
    """A command on one entity."""

    id: uuid.UUID


class Nutrients(BaseModel):
    """Absolute nutrient amounts of something eaten or drunk."""

    kcal: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    fiber_g: float = 0
    sugar_g: float = 0
    salt_g: float = 0
    fluid_ml: float = 0

    def __add__(self, other: "Nutrients") -> "Nutrients":
        return Nutrients(
            **{name: round(getattr(self, name) + getattr(other, name), 2) for name in Nutrients.model_fields}
        )

    def scaled(self, factor: float) -> "Nutrients":
        """These amounts multiplied by a factor."""
        return Nutrients(**{name: round(getattr(self, name) * factor, 2) for name in Nutrients.model_fields})

    @classmethod
    def total(cls, items: Iterable["Nutrients"]) -> "Nutrients":
        """The sum of many; zero for none."""
        result = cls()
        for item in items:
            result = result + item
        return result


def encode_cursor(data: dict[str, Any]) -> str:
    """An opaque, URL-safe pagination cursor."""
    return base64.urlsafe_b64encode(json.dumps(data, sort_keys=True).encode()).decode()


def decode_cursor(cursor: str) -> dict[str, Any]:
    """Read a cursor made by encode_cursor; anything else is a validation error."""
    try:
        value = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise ValidationFailed("invalid cursor", "cursor") from exc
    if not isinstance(value, dict):
        raise ValidationFailed("invalid cursor", "cursor")
    return value
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/helpers -q`
Expected: all pass (`19 passed`)

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(helpers): error model, command responses and universal data models

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: Helpers for the database, idempotency and database test fixtures

**Files:**
- Create: `backend/app/helpers/database.py`, `backend/app/helpers/idempotency.py`, `backend/tests/conftest.py`
- Test: `backend/tests/helpers/test_database.py`

**Interfaces:**
- Consumes: `get_settings` (Task 1), `Conflict` (Task 2).
- Produces:
  - `Base` (declarative; `datetime` maps to `timestamptz`; `dict[str, Any]` and
    `list[Any]` map to `JSONB`), `CreatedAtMixin`
  - `open_session() -> AbstractAsyncContextManager[AsyncSession]`,
    `override_session_provider(provider | None) -> None`
  - `try_advisory_xact_lock(session, key: int) -> bool`, `ping(session) -> None`,
    `dispose_engine() -> None`
  - `CommandLog` (table `command_log`)
  - `replay(session, key: str, command: str) -> dict | None` (raises `Conflict` when the
    key belongs to another command), `remember(session, key, command, response: dict) -> None`
  - test fixtures `schema`, `session` and `db`, plus the marker `requires_db`, in
    `tests/conftest.py`

- [ ] **Step 1: Write `tests/conftest.py` and the failing tests**

`backend/tests/conftest.py`:

```python
"""Shared fixtures. Tests that need Postgres are marked requires_db and skip without
TEST_DATABASE_URL (see README); everything else runs anywhere."""

import os

os.environ.update(
    {
        "OWNER_SUB": "11111111-1111-1111-1111-111111111111",
        "KEYCLOAK_URL": "http://keycloak.test",
        "KEYCLOAK_PUBLIC_URL": "http://keycloak.test",
        "KEYCLOAK_REALM": "daily2",
        "MCP_RESOURCE_URL": "http://testserver/mcp",
        "MCP_ALLOWED_HOSTS": '["testserver"]',
        "DEFAULT_TIMEZONE": "Europe/Berlin",
        "LOG_JSON": "false",
        "GYM_BRO_URL": "",
        "GYM_BRO_CLIENT_SECRET": "",
    }
)
if os.getenv("TEST_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]

from collections.abc import AsyncIterator, Iterator  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import app.helpers.idempotency  # noqa: E402, F401
from app.helpers.database import Base, override_session_provider  # noqa: E402

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")

requires_db = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL is not set")


@pytest.fixture(scope="session")
def schema() -> Iterator[None]:
    """Create every table once per run over a synchronous connection, drop them afterwards."""
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not set")
    engine = create_engine(TEST_DATABASE_URL)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest_asyncio.fixture
async def session(schema) -> AsyncIterator[AsyncSession]:
    """A session inside a transaction that is rolled back after the test; the code's own
    commit() only releases a savepoint."""
    engine = create_async_engine(TEST_DATABASE_URL, connect_args={"options": "-c timezone=utc"})
    connection = await engine.connect()
    transaction = await connection.begin()
    factory = async_sessionmaker(
        bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )
    async with factory() as db_session:
        yield db_session
    await transaction.rollback()
    await connection.close()
    await engine.dispose()


@pytest.fixture
def db(session: AsyncSession) -> Iterator[AsyncSession]:
    """Route open_session() to the test session, so REST and MCP calls share the rollback."""

    @asynccontextmanager
    async def provider() -> AsyncIterator[AsyncSession]:
        yield session

    override_session_provider(provider)
    yield session
    override_session_provider(None)
```

The `noqa: E402` markers are needed because the environment has to be set before any
`app` import reads settings. This is the one place where import order is load-bearing.

`backend/tests/helpers/test_database.py`:

```python
import pytest
import sqlalchemy as sa

from app.helpers.database import open_session, ping, try_advisory_xact_lock
from app.helpers.errors import Conflict
from app.helpers.idempotency import remember, replay
from tests.conftest import requires_db

pytestmark = requires_db


async def test_open_session_uses_the_overridden_provider(db):
    async with open_session() as session:
        assert session is db
        await ping(session)


async def test_advisory_lock_is_taken_once_per_transaction(db):
    assert await try_advisory_xact_lock(db, 4242) is True
    assert await db.scalar(sa.select(sa.func.pg_try_advisory_xact_lock(4242))) is True


async def test_replay_returns_the_remembered_response(db):
    assert await replay(db, "k1", "log_events") is None
    remember(db, "k1", "log_events", {"result": {"n": 1}})
    await db.flush()
    assert await replay(db, "k1", "log_events") == {"result": {"n": 1}}


async def test_replay_rejects_a_key_used_for_another_command(db):
    remember(db, "k2", "log_events", {"result": {}})
    await db.flush()
    with pytest.raises(Conflict) as caught:
        await replay(db, "k2", "retract_event")
    assert caught.value.field == "idempotency_key"
```

- [ ] **Step 2: Run them to see them fail**

Start a throwaway Postgres for tests (Task 17 adds this service to compose; until then
use this one-off container):

```bash
docker run -d --name daily2-testdb -e POSTGRES_USER=daily2 -e POSTGRES_PASSWORD=daily2 -e POSTGRES_DB=daily2_test -p 55433:5432 postgres:18-alpine
export TEST_DATABASE_URL=postgresql+psycopg://daily2:daily2@localhost:55433/daily2_test
```

Run: `cd backend && uv run pytest tests/helpers/test_database.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.helpers.idempotency'`

- [ ] **Step 3: Implement**

`backend/app/helpers/database.py`:

```python
"""The database: declarative base, one lazily built engine, and a swappable session source."""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import datetime
from functools import lru_cache
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.helpers.config import get_settings

SessionProvider = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class Base(DeclarativeBase):
    """Base of every table."""

    type_annotation_map = {
        datetime: sa.DateTime(timezone=True),
        dict[str, Any]: JSONB,
        list[Any]: JSONB,
    }


class CreatedAtMixin:
    """A server-set creation timestamp."""

    created_at: Mapped[datetime] = mapped_column(server_default=sa.func.now())


@lru_cache
def _engine() -> AsyncEngine:
    return create_async_engine(
        get_settings().database_url,
        pool_pre_ping=True,
        connect_args={"options": "-c timezone=utc"},
    )


@lru_cache
def _sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(_engine(), expire_on_commit=False)


@asynccontextmanager
async def _default_session() -> AsyncIterator[AsyncSession]:
    async with _sessionmaker()() as session:
        yield session


_provider: SessionProvider = _default_session


def open_session() -> AbstractAsyncContextManager[AsyncSession]:
    """A session from the current provider; REST, MCP and background jobs all use this."""
    return _provider()


def override_session_provider(provider: SessionProvider | None) -> None:
    """Swap where sessions come from (tests); None restores the default."""
    global _provider
    _provider = provider or _default_session


async def dispose_engine() -> None:
    """Close the pool, if one was ever opened."""
    if _engine.cache_info().currsize:
        await _engine().dispose()
        _engine.cache_clear()
        _sessionmaker.cache_clear()


async def try_advisory_xact_lock(session: AsyncSession, key: int) -> bool:
    """Take a transaction-scoped advisory lock without waiting."""
    return bool(await session.scalar(sa.select(sa.func.pg_try_advisory_xact_lock(key))))


async def ping(session: AsyncSession) -> None:
    """Round-trip to the database."""
    await session.execute(sa.text("SELECT 1"))
```

`backend/app/helpers/idempotency.py`:

```python
"""Idempotent commands: a repeated key returns the stored response instead of re-running."""

from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base
from app.helpers.errors import Conflict


class CommandLog(Base):
    """One remembered command response per idempotency key."""

    __tablename__ = "command_log"

    idempotency_key: Mapped[str] = mapped_column(sa.String(200), primary_key=True)
    command: Mapped[str] = mapped_column(sa.String(100))
    response: Mapped[dict[str, Any]]
    created_at: Mapped[datetime] = mapped_column(server_default=sa.func.now())


async def replay(session: AsyncSession, key: str, command: str) -> dict[str, Any] | None:
    """The stored response for a key, None if unused; a key of another command is a conflict."""
    row = await session.get(CommandLog, key)
    if row is None:
        return None
    if row.command != command:
        raise Conflict(f"idempotency key was already used for {row.command}", "idempotency_key")
    return row.response


def remember(session: AsyncSession, key: str, command: str, response: dict[str, Any]) -> None:
    """Store a response; it is committed together with the command's own writes."""
    session.add(CommandLog(idempotency_key=key, command=command, response=response))
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: every test passes, including `4 passed` in `test_database.py`

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(helpers): database, idempotency log and database test fixtures

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Keycloak helpers

**Files:**
- Create: `backend/app/helpers/auth.py`, `backend/tests/tokens.py`
- Modify: `backend/tests/conftest.py` (append the `validator` fixture)
- Test: `backend/tests/helpers/test_auth.py`

**Interfaces:**
- Consumes: `Settings`, `get_settings` (Task 1); `Unauthorized`, `Forbidden`, `Upstream`
  (Task 2); `get_logger`, `utcnow` (Task 1).
- Produces:
  - `JwksUnavailable`
  - `TokenValidator(issuer, fetch_jwks, ttl_seconds=300, cooldown_seconds=30, max_stale_seconds=86400, clock=time.monotonic)`
    with `async decode(token) -> dict`
  - `http_jwks_fetcher(url) -> JwksFetcher`
  - `get_token_validator() -> TokenValidator`, `override_token_validator(v | None) -> None`
  - `Source = Literal["app", "claude", "system"]`
  - `Principal(sub: str, client_id: str, source: Source)`, and `SYSTEM` (a `Principal` for
    background jobs)
  - `verify_access_token(token, settings, validator) -> dict` (raises `Unauthorized`,
    `Forbidden` or `Upstream`)
  - `rest_principal(request) -> Principal` (a FastAPI dependency; requires `azp == app_client_id`)
  - `McpTokenVerifier(settings)` (a `TokenVerifier` for the MCP SDK),
    `mcp_principal() -> Principal`
  - `ClientCredentials(token_url, client_id, client_secret, http, clock=utcnow)` with
    `async token() -> str` and `async aclose()`
  - in `tests/tokens.py`: `OWNER_SUB`, `ISSUER`, `KEY`, `JWKS`, `fetch_jwks()`,
    `make_token(**claims)`, `app_token()`, `mcp_token()`

- [ ] **Step 1: Write the token helpers, the fixture and the failing tests**

`backend/tests/tokens.py`:

```python
"""Throwaway RSA keys and Keycloak-shaped tokens; nothing here talks to a real Keycloak."""

import os
import time
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

OWNER_SUB = os.environ["OWNER_SUB"]
ISSUER = "http://keycloak.test/realms/daily2"
RESOURCE_URL = "http://testserver/mcp"

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)

_jwk: dict[str, Any] = RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True)
_jwk.update(kid="test-key", use="sig", alg="RS256")
JWKS: dict[str, Any] = {"keys": [_jwk]}


async def fetch_jwks() -> dict[str, Any]:
    """The fixed test key set."""
    return JWKS


def make_token(*, key: Any = KEY, kid: str | None = "test-key", omit: tuple[str, ...] = (), **claims: Any) -> str:
    """A signed access token for the owner via daily2-app, with claims overridable."""
    now = int(time.time())
    body: dict[str, Any] = {
        "iss": ISSUER,
        "sub": OWNER_SUB,
        "azp": "daily2-app",
        "aud": ["account"],
        "typ": "Bearer",
        "scope": "openid profile",
        "exp": now + 300,
        "iat": now,
        **claims,
    }
    for name in omit:
        body.pop(name, None)
    return jwt.encode(body, key, algorithm="RS256", headers={"kid": kid} if kid else {})


def app_token(**claims: Any) -> str:
    """A token the REST API accepts."""
    return make_token(**claims)


def mcp_token(**claims: Any) -> str:
    """A token the MCP server accepts."""
    return make_token(azp="daily2-mcp", aud=[RESOURCE_URL], **claims)
```

Append to `backend/tests/conftest.py`:

```python
from app.helpers.auth import TokenValidator, override_token_validator  # noqa: E402
from tests.tokens import ISSUER, fetch_jwks  # noqa: E402


@pytest.fixture(autouse=True)
def validator() -> Iterator[TokenValidator]:
    """Verify tokens against the in-memory test keys instead of a real Keycloak."""
    token_validator = TokenValidator(ISSUER, fetch_jwks)
    override_token_validator(token_validator)
    yield token_validator
    override_token_validator(None)
```

`backend/tests/helpers/test_auth.py`:

```python
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from starlette.requests import Request

from app.helpers.auth import (
    ClientCredentials,
    JwksUnavailable,
    McpTokenVerifier,
    TokenValidator,
    rest_principal,
    verify_access_token,
)
from app.helpers.config import get_settings
from app.helpers.errors import Forbidden, Unauthorized, Upstream
from tests.tokens import ISSUER, JWKS, OTHER_KEY, OWNER_SUB, RESOURCE_URL, app_token, fetch_jwks, make_token, mcp_token


def _request(authorization: str | None) -> Request:
    headers = [(b"authorization", authorization.encode())] if authorization else []
    return Request({"type": "http", "headers": headers})


async def test_decode_accepts_a_valid_token():
    claims = await TokenValidator(ISSUER, fetch_jwks).decode(app_token())
    assert claims["sub"] == OWNER_SUB


async def test_decode_rejects_a_wrong_issuer_and_a_foreign_key():
    validator = TokenValidator(ISSUER, fetch_jwks)
    with pytest.raises(jwt.InvalidIssuerError):
        await validator.decode(make_token(iss="http://evil/realms/daily2"))
    with pytest.raises(jwt.InvalidSignatureError):
        await validator.decode(make_token(key=OTHER_KEY))


async def test_unknown_kid_forces_one_refresh_then_respects_the_cooldown():
    calls = 0

    async def counting_fetch():
        nonlocal calls
        calls += 1
        return JWKS

    validator = TokenValidator(ISSUER, counting_fetch)
    for _ in range(2):
        with pytest.raises(jwt.InvalidKeyError):
            await validator.decode(make_token(kid="unknown"))
    assert calls == 2


async def test_cached_keys_survive_a_failing_refresh_until_they_are_too_stale():
    now = [0.0]
    fail = [False]

    async def flaky_fetch():
        if fail[0]:
            raise JwksUnavailable("down")
        return JWKS

    validator = TokenValidator(ISSUER, flaky_fetch, ttl_seconds=10, max_stale_seconds=100, clock=lambda: now[0])
    await validator.decode(app_token())
    fail[0] = True
    now[0] = 50
    assert (await validator.decode(app_token()))["sub"] == OWNER_SUB
    now[0] = 500
    with pytest.raises(JwksUnavailable):
        await validator.decode(app_token())


async def test_verify_access_token_maps_every_failure():
    settings = get_settings()
    good = TokenValidator(ISSUER, fetch_jwks)
    assert (await verify_access_token(app_token(), settings, good))["sub"] == OWNER_SUB
    with pytest.raises(Unauthorized):
        await verify_access_token("not-a-jwt", settings, good)
    with pytest.raises(Unauthorized):
        await verify_access_token(make_token(typ="ID"), settings, good)
    with pytest.raises(Forbidden):
        await verify_access_token(make_token(sub="someone-else"), settings, good)

    async def down():
        raise JwksUnavailable("down")

    with pytest.raises(Upstream):
        await verify_access_token(app_token(), settings, TokenValidator(ISSUER, down))


async def test_rest_principal_requires_a_bearer_token_for_the_app_client():
    principal = await rest_principal(_request(f"Bearer {app_token()}"))
    assert (principal.sub, principal.source) == (OWNER_SUB, "app")
    with pytest.raises(Unauthorized):
        await rest_principal(_request(None))
    with pytest.raises(Unauthorized):
        await rest_principal(_request("Basic abc"))
    with pytest.raises(Forbidden):
        await rest_principal(_request(f"Bearer {mcp_token()}"))


async def test_mcp_verifier_requires_the_resource_audience_and_the_mcp_client():
    verifier = McpTokenVerifier(get_settings())
    access = await verifier.verify_token(mcp_token())
    assert access is not None
    assert (access.subject, access.client_id, access.resource) == (OWNER_SUB, "daily2-mcp", RESOURCE_URL)
    assert "openid" in access.scopes
    assert await verifier.verify_token(make_token(azp="daily2-mcp")) is None
    assert await verifier.verify_token(app_token(aud=[RESOURCE_URL])) is None
    assert await verifier.verify_token(mcp_token(sub="someone-else")) is None


async def test_client_credentials_caches_until_shortly_before_expiry():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"access_token": f"t{calls}", "expires_in": 300})

    now = [datetime(2026, 9, 30, tzinfo=UTC)]
    provider = ClientCredentials(
        "http://kc/token", "svc", "secret", httpx.AsyncClient(transport=httpx.MockTransport(handler)), clock=lambda: now[0]
    )
    assert await provider.token() == "t1"
    assert await provider.token() == "t1"
    now[0] += timedelta(seconds=280)
    assert await provider.token() == "t2"
    await provider.aclose()


async def test_client_credentials_failures_are_upstream_errors():
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": True})

    provider = ClientCredentials("http://kc/token", "svc", "s", httpx.AsyncClient(transport=httpx.MockTransport(broken)))
    with pytest.raises(Upstream):
        await provider.token()

    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    provider = ClientCredentials("http://kc/token", "svc", "s", httpx.AsyncClient(transport=httpx.MockTransport(down)))
    with pytest.raises(Upstream):
        await provider.token()
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/helpers/test_auth.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.helpers.auth'`

- [ ] **Step 3: Implement**

`backend/app/helpers/auth.py`:

```python
"""Keycloak: access-token verification for REST and MCP, and client-credentials tokens."""

import asyncio
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Literal

import httpx
import jwt
from fastapi import Request
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier

from app.helpers.config import Settings, get_settings
from app.helpers.errors import Forbidden, Unauthorized, Upstream
from app.helpers.logging import get_logger
from app.helpers.time import utcnow

logger = get_logger("auth")

JwksFetcher = Callable[[], Awaitable[dict[str, Any]]]
Source = Literal["app", "claude", "system"]


class JwksUnavailable(Exception):
    """The realm's signing keys could not be fetched and no usable cached copy exists."""


class TokenValidator:
    """Verifies RS256 access tokens from one realm, caching its JWKS."""

    def __init__(
        self,
        issuer: str,
        fetch_jwks: JwksFetcher,
        ttl_seconds: float = 300,
        cooldown_seconds: float = 30,
        max_stale_seconds: float = 86400,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._issuer = issuer
        self._fetch = fetch_jwks
        self._ttl = ttl_seconds
        self._cooldown = cooldown_seconds
        self._max_stale = max_stale_seconds
        self._clock = clock
        self._jwks: dict[str, Any] | None = None
        self._fetched_at = -math.inf
        self._forced_at = -math.inf
        self._lock: asyncio.Lock | None = None

    async def _keys(self, force: bool) -> dict[str, Any]:
        now = self._clock()
        if self._jwks is not None and not force and now - self._fetched_at < self._ttl:
            return self._jwks
        if force and self._jwks is not None and now - self._forced_at < self._cooldown:
            return self._jwks
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if force:
                self._forced_at = now
            try:
                self._jwks = await self._fetch()
                self._fetched_at = self._clock()
            except JwksUnavailable:
                if self._jwks is None or now - self._fetched_at > self._max_stale:
                    raise
                logger.warning("JWKS refresh failed; using the cached keys")
        return self._jwks

    @staticmethod
    def _find(jwks: dict[str, Any], kid: str | None) -> jwt.PyJWK | None:
        for entry in jwks.get("keys") or []:
            if not isinstance(entry, dict) or entry.get("kid") != kid:
                continue
            if entry.get("kty") != "RSA" or entry.get("use") not in (None, "sig"):
                continue
            if entry.get("alg") not in (None, "RS256"):
                continue
            try:
                return jwt.PyJWK.from_dict(entry)
            except (jwt.PyJWKError, ValueError, TypeError):
                return None
        return None

    async def decode(self, token: str) -> dict[str, Any]:
        """Verified claims; raises jwt.PyJWTError or JwksUnavailable."""
        kid = jwt.get_unverified_header(token).get("kid")
        key = self._find(await self._keys(force=False), kid)
        if key is None:
            key = self._find(await self._keys(force=True), kid)
        if key is None:
            raise jwt.InvalidKeyError("unknown signing key")
        return jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            issuer=self._issuer,
            leeway=30,
            options={"verify_aud": False, "require": ["exp", "iss", "sub"]},
        )


def http_jwks_fetcher(url: str) -> JwksFetcher:
    """A fetcher that GETs the JWKS document over HTTP."""

    async def fetch() -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(url)
                response.raise_for_status()
                body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise JwksUnavailable(url) from exc
        if not isinstance(body, dict) or not isinstance(body.get("keys"), list):
            raise JwksUnavailable(url)
        return body

    return fetch


_validator_override: TokenValidator | None = None


@lru_cache
def _default_validator() -> TokenValidator:
    settings = get_settings()
    return TokenValidator(settings.keycloak_issuer, http_jwks_fetcher(settings.keycloak_jwks_uri))


def get_token_validator() -> TokenValidator:
    """The validator in use: the override if set, else the process-wide one."""
    return _validator_override or _default_validator()


def override_token_validator(validator: TokenValidator | None) -> None:
    """Swap the validator (tests); None restores the default."""
    global _validator_override
    _validator_override = validator


@dataclass(frozen=True)
class Principal:
    """Who is calling: the owner through the app or Claude, or the system itself."""

    sub: str
    client_id: str
    source: Source


SYSTEM = Principal(sub="system", client_id="system", source="system")


async def verify_access_token(token: str, settings: Settings, validator: TokenValidator) -> dict[str, Any]:
    """Claims of a valid owner access token; anything else raises an AppError."""
    try:
        claims = await validator.decode(token)
    except JwksUnavailable as exc:
        raise Upstream("identity provider unreachable") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("invalid token") from exc
    if claims.get("typ") != "Bearer":
        raise Unauthorized("invalid token")
    if not settings.owner_sub or claims.get("sub") != settings.owner_sub:
        raise Forbidden("caller is not the owner")
    return claims


async def rest_principal(request: Request) -> Principal:
    """FastAPI dependency: the owner calling through the daily2-app client."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized("missing bearer token")
    settings = get_settings()
    claims = await verify_access_token(token, settings, get_token_validator())
    if claims.get("azp") != settings.app_client_id:
        raise Forbidden("token was not issued for this application")
    return Principal(sub=claims["sub"], client_id=settings.app_client_id, source="app")


class McpTokenVerifier(TokenVerifier):
    """Lets the MCP SDK accept only owner tokens of daily2-mcp minted for this resource."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            claims = await verify_access_token(token, self._settings, get_token_validator())
        except (Unauthorized, Forbidden, Upstream):
            return None
        audience = claims.get("aud", [])
        audience = [audience] if isinstance(audience, str) else list(audience)
        if self._settings.mcp_resource_url not in audience:
            return None
        if claims.get("azp") != self._settings.mcp_client_id:
            return None
        return AccessToken(
            token=token,
            client_id=claims["azp"],
            scopes=claims.get("scope", "").split(),
            expires_at=claims.get("exp"),
            resource=self._settings.mcp_resource_url,
            subject=claims["sub"],
            claims={"iss": claims["iss"]},
        )


def mcp_principal() -> Principal:
    """The caller of the current MCP request, as verified by McpTokenVerifier."""
    access = get_access_token()
    if access is None or access.subject is None:
        raise Unauthorized("missing token")
    return Principal(sub=access.subject, client_id=access.client_id, source="claude")


class ClientCredentials:
    """A service account's access token, cached until 30 seconds before it expires."""

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        http: httpx.AsyncClient,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http
        self._clock = clock
        self._token: str | None = None
        self._expires_at: datetime | None = None

    async def token(self) -> str:
        """A valid bearer token; raises Upstream when Keycloak does not issue one."""
        now = self._clock()
        if self._token is not None and self._expires_at is not None and now < self._expires_at:
            return self._token
        try:
            response = await self._http.post(
                self._token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                },
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise Upstream("identity provider did not issue a token") from exc
        token, expires_in = body.get("access_token"), body.get("expires_in")
        if not isinstance(token, str) or not isinstance(expires_in, int | float):
            raise Upstream("identity provider returned an invalid token response")
        self._token = token
        self._expires_at = now + timedelta(seconds=max(0.0, expires_in - 30))
        return token

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._http.aclose()
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_auth.py`: `9 passed`)

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(helpers): Keycloak token verification for REST and MCP, client credentials

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Helpers for services and the app lifespan

**Files:**
- Create: `backend/app/helpers/services.py`, `backend/app/helpers/lifespan.py`
- Test: `backend/tests/helpers/test_services.py`

**Interfaces:**
- Consumes: `configure_logging` (Task 1), `dispose_engine` (Task 3).
- Produces:
  - `ServiceRegistry` with `register(name, factory)`, `get(name)`,
    `override(name, instance)`, `is_registered(name) -> bool` and `async aclose()`
  - `services` (the process-wide registry)
  - `lifespan(app)`: configures logging on start; on stop closes every service and
    disposes the engine. Feature lifespans (MCP, sync loops) are carried by their routers
    and run inside it.

- [ ] **Step 1: Write the failing tests**

`backend/tests/helpers/test_services.py`:

```python
import pytest
from fastapi import FastAPI

from app.helpers.lifespan import lifespan
from app.helpers.services import ServiceRegistry, services


class _Client:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


async def test_services_are_built_lazily_once():
    registry = ServiceRegistry()
    built = []
    registry.register("off", lambda: built.append(1) or _Client())
    assert built == []
    first = registry.get("off")
    assert registry.get("off") is first
    assert built == [1]


async def test_override_replaces_the_instance_and_aclose_closes_everything():
    registry = ServiceRegistry()
    registry.register("off", _Client)
    fake = _Client()
    registry.override("off", fake)
    assert registry.get("off") is fake
    await registry.aclose()
    assert fake.closed
    assert registry.get("off") is not fake


def test_unknown_service_is_a_key_error():
    with pytest.raises(KeyError):
        ServiceRegistry().get("nope")
    assert ServiceRegistry().is_registered("nope") is False


async def test_lifespan_closes_services_on_shutdown():
    fake = _Client()
    services.register("test-only", _Client)
    services.override("test-only", fake)
    app = FastAPI(lifespan=lifespan)
    async with app.router.lifespan_context(app):
        assert not fake.closed
    assert fake.closed
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/helpers/test_services.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.helpers.services'`

- [ ] **Step 3: Implement**

`backend/app/helpers/services.py`:

```python
"""External clients as named, lazily built, overridable services."""

from collections.abc import Callable
from typing import Any


class ServiceRegistry:
    """Named factories whose instances are built on first use and closed on shutdown."""

    def __init__(self) -> None:
        self._factories: dict[str, Callable[[], Any]] = {}
        self._instances: dict[str, Any] = {}

    def register(self, name: str, factory: Callable[[], Any]) -> None:
        """Declare how to build a service."""
        self._factories[name] = factory

    def is_registered(self, name: str) -> bool:
        """Whether a factory exists for the name."""
        return name in self._factories

    def get(self, name: str) -> Any:
        """The instance, built on first use; KeyError for an unknown name."""
        if name not in self._instances:
            self._instances[name] = self._factories[name]()
        return self._instances[name]

    def override(self, name: str, instance: Any) -> None:
        """Use this instance instead of building one (tests)."""
        self._instances[name] = instance

    async def aclose(self) -> None:
        """Close every built instance that has aclose(), then forget them all."""
        for instance in self._instances.values():
            close = getattr(instance, "aclose", None)
            if close is not None:
                await close()
        self._instances.clear()


services = ServiceRegistry()
```

`backend/app/helpers/lifespan.py`:

```python
"""The app's own lifespan; feature routers add theirs through include_router."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.helpers.config import get_settings
from app.helpers.database import dispose_engine
from app.helpers.logging import configure_logging
from app.helpers.services import services


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Configure logging; on shutdown close services and the database pool."""
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    try:
        yield
    finally:
        await services.aclose()
        await dispose_engine()
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_services.py`: `4 passed`)

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(helpers): service registry and app lifespan

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Helpers for operations and REST endpoints

This is the universal machinery. A feature declares `Operation`s once, and this task turns
each one into a REST route with auth, validation, idempotency, one transaction, the
`CommandResponse` envelope, error translation and OpenAPI error docs.

**Files:**
- Create: `backend/app/helpers/endpoints.py`, `backend/tests/helpers/toy.py`
- Test: `backend/tests/helpers/test_endpoints.py`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `Context(session, principal, settings, now)`
  - `Operation(name, kind, input, output, handler, description, errors=(), view=None, rest_path=None, destructive=False)`,
    with the properties `.response_model` and `.rest -> tuple[method, path] | None`
  - `command(name, input, output, handler, description, *, errors=(), destructive=False) -> Operation`
  - `query(name, input, output, handler, description, *, errors=(), view=None, rest_path=None) -> Operation`
  - `BASE_ERRORS`
  - `FeatureApi(name, operations, schemas={}, lifespan=None)` with `.router() -> APIRouter`
  - `async execute(op, principal, data) -> BaseModel`
  - `error_response(exc) -> JSONResponse`, `AppRoute`
  - `SchemasOut`, `schemas_api(apis) -> FeatureApi` (operation `get_schemas`, `GET /schemas`)
  - `fallback_router() -> APIRouter`

  Handler contract: a command handler is `async (ctx, data) -> Outcome[output]`, and a
  query handler is `async (ctx, data) -> output`. Handlers never commit and never open a
  session.

  REST contract: commands are `POST /commands/{name}` with the input as the JSON body.
  Queries are `GET /views/{view}` or `GET {rest_path}` with the input as query parameters.
  A query with neither is MCP-only.

- [ ] **Step 1: Write the toy feature and the failing tests**

`backend/tests/helpers/toy.py`:

```python
"""A minimal feature used to test the operation machinery in isolation."""

from typing import Literal

from pydantic import BaseModel, Field

from app.helpers.endpoints import Context, FeatureApi, command, query
from app.helpers.errors import NotFound
from app.helpers.models import CommandInput, QueryInput
from app.helpers.responses import Outcome

CALLS = {"note": 0}


class NoteMissing(NotFound):
    """The toy's own not-found error."""


class NoteIn(CommandInput):
    text: str = Field(min_length=1, max_length=50, description="What to note.")
    fail: Literal["none", "not_found", "boom"] = "none"


class NoteOut(BaseModel):
    text: str
    calls: int


class EchoIn(QueryInput):
    word: str = Field(min_length=1)
    times: int = Field(default=1, ge=1, le=3)


class EchoOut(BaseModel):
    words: list[str]
    source: str


async def note(ctx: Context, data: NoteIn) -> Outcome[NoteOut]:
    if data.fail == "not_found":
        raise NoteMissing("no such note", "text")
    if data.fail == "boom":
        raise RuntimeError("secret detail")
    CALLS["note"] += 1
    return Outcome(NoteOut(text=data.text, calls=CALLS["note"]), days={ctx.now.date()}, warnings=["toy"])


async def echo(ctx: Context, data: EchoIn) -> EchoOut:
    return EchoOut(words=[data.word] * data.times, source=ctx.principal.source)


TOY = FeatureApi(
    name="toy",
    operations=(
        command("note_it", NoteIn, NoteOut, note, "Store a note.", errors=(NoteMissing,)),
        query("echo", EchoIn, EchoOut, echo, "Echo a word.", view="echo"),
        query("secret_echo", EchoIn, EchoOut, echo, "MCP-only echo."),
    ),
)
```

`backend/tests/helpers/test_endpoints.py`:

```python
import httpx
import pytest
from fastapi import FastAPI

from app.helpers.endpoints import fallback_router, schemas_api
from app.helpers.time import utcnow
from tests.conftest import requires_db
from tests.helpers.toy import CALLS, TOY
from tests.tokens import app_token, make_token, mcp_token

pytestmark = requires_db


def _app() -> FastAPI:
    app = FastAPI()
    for api in (TOY, schemas_api((TOY,))):
        app.include_router(api.router(), prefix="/api/v2")
    app.include_router(fallback_router())
    return app


@pytest.fixture
async def client(db):
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", headers={"Authorization": f"Bearer {app_token()}"}
    ) as http:
        yield http


async def test_command_returns_the_envelope(client):
    response = await client.post("/api/v2/commands/note_it", json={"text": "hi"})
    assert response.status_code == 200
    body = response.json()
    assert body["result"]["text"] == "hi"
    assert body["effects"] == {"days": [utcnow().date().isoformat()]}
    assert body["warnings"] == ["toy"]


async def test_idempotency_key_replays_without_running_again(client):
    before = CALLS["note"]
    first = await client.post("/api/v2/commands/note_it", json={"text": "a", "idempotency_key": "same"})
    second = await client.post("/api/v2/commands/note_it", json={"text": "a", "idempotency_key": "same"})
    assert first.json() == second.json()
    assert CALLS["note"] == before + 1


@pytest.mark.parametrize(
    ("body", "field"),
    [({"text": ""}, "text"), ({"text": "x", "surprise": 1}, "surprise"), ({}, "text")],
)
async def test_invalid_command_input_is_a_validation_error(client, body, field):
    response = await client.post("/api/v2/commands/note_it", json=body)
    assert response.status_code == 422
    assert response.json()["code"] == "validation"
    assert response.json()["field"] == field


async def test_feature_errors_keep_their_code_message_and_field(client):
    response = await client.post("/api/v2/commands/note_it", json={"text": "x", "fail": "not_found"})
    assert response.status_code == 404
    assert response.json() == {"code": "not_found", "message": "no such note", "field": "text"}


async def test_unexpected_errors_are_hidden(client):
    response = await client.post("/api/v2/commands/note_it", json={"text": "x", "fail": "boom"})
    assert response.status_code == 500
    assert response.json() == {"code": "internal", "message": "internal error", "field": None}


async def test_auth_failures(db):
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        missing = await http.post("/api/v2/commands/note_it", json={"text": "x"})
        assert missing.status_code == 401
        assert missing.headers["www-authenticate"] == "Bearer"
        wrong_client = await http.get(
            "/api/v2/views/echo", params={"word": "x"}, headers={"Authorization": f"Bearer {mcp_token()}"}
        )
        assert (wrong_client.status_code, wrong_client.json()["code"]) == (403, "forbidden")
        stranger = await http.get(
            "/api/v2/views/echo", params={"word": "x"}, headers={"Authorization": f"Bearer {make_token(sub='x')}"}
        )
        assert stranger.status_code == 403


async def test_query_reads_query_parameters(client):
    response = await client.get("/api/v2/views/echo", params={"word": "hi", "times": 2})
    assert response.json() == {"words": ["hi", "hi"], "source": "app"}
    bad = await client.get("/api/v2/views/echo", params={"word": "hi", "times": 9})
    assert (bad.status_code, bad.json()["field"]) == (422, "times")
    extra = await client.get("/api/v2/views/echo", params={"word": "hi", "other": 1})
    assert extra.status_code == 422


async def test_mcp_only_queries_have_no_route_and_unknown_routes_are_not_found(client):
    for path in ("/api/v2/views/secret_echo", "/api/v2/nope"):
        response = await client.get(path)
        assert (response.status_code, response.json()["code"]) == (404, "not_found")


async def test_schemas_lists_every_operation(client):
    body = (await client.get("/api/v2/schemas")).json()
    assert set(body["commands"]) == {"note_it"}
    assert set(body["queries"]) == {"echo", "secret_echo", "get_schemas"}
    assert body["commands"]["note_it"]["properties"]["text"]["description"] == "What to note."


async def test_openapi_documents_declared_errors(client):
    spec = (await client.get("/openapi.json")).json()
    responses = spec["paths"]["/api/v2/commands/note_it"]["post"]["responses"]
    assert {"401", "403", "404", "422", "500", "503"} <= set(responses)
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/helpers/test_endpoints.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.helpers.endpoints'`

- [ ] **Step 3: Implement**

`backend/app/helpers/endpoints.py`:

```python
"""Operations: declared once in a feature's routers.py, served as REST routes and MCP tools."""

import inspect
from collections.abc import Awaitable, Callable, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.helpers import idempotency
from app.helpers.auth import Principal, rest_principal
from app.helpers.config import Settings, get_settings
from app.helpers.database import open_session
from app.helpers.errors import (
    AppError,
    Forbidden,
    Internal,
    NotFound,
    Unauthorized,
    Upstream,
    ValidationFailed,
    to_app_error,
)
from app.helpers.models import EmptyQuery
from app.helpers.responses import CommandResponse, Effects, Outcome, error_responses
from app.helpers.time import utcnow

BASE_ERRORS: tuple[type[AppError], ...] = (ValidationFailed, Unauthorized, Forbidden, Upstream, Internal)

Handler = Callable[["Context", Any], Awaitable[Any]]
Lifespan = Callable[[Any], AbstractAsyncContextManager[None]]


@dataclass(frozen=True)
class Context:
    """What a handler may use; the session is opened and committed by the machinery."""

    session: AsyncSession
    principal: Principal
    settings: Settings
    now: datetime


@dataclass(frozen=True)
class Operation:
    """One command or query, declared once and served over REST and MCP."""

    name: str
    kind: Literal["command", "query"]
    input: type[BaseModel]
    output: type[BaseModel]
    handler: Handler
    description: str
    errors: tuple[type[AppError], ...] = ()
    view: str | None = None
    rest_path: str | None = None
    destructive: bool = False

    @property
    def response_model(self) -> type[BaseModel]:
        """Commands answer with the CommandResponse envelope, queries with their output."""
        if self.kind == "command":
            return CommandResponse[self.output]
        return self.output

    @property
    def rest(self) -> tuple[str, str] | None:
        """(method, path) of the REST route, or None for MCP-only queries."""
        if self.kind == "command":
            return "POST", f"/commands/{self.name}"
        if self.rest_path:
            return "GET", self.rest_path
        if self.view:
            return "GET", f"/views/{self.view}"
        return None


def command(
    name: str,
    input: type[BaseModel],
    output: type[BaseModel],
    handler: Handler,
    description: str,
    *,
    errors: tuple[type[AppError], ...] = (),
    destructive: bool = False,
) -> Operation:
    """Declare a command (POST /commands/{name}); its handler returns an Outcome."""
    return Operation(name, "command", input, output, handler, description, errors, destructive=destructive)


def query(
    name: str,
    input: type[BaseModel],
    output: type[BaseModel],
    handler: Handler,
    description: str,
    *,
    errors: tuple[type[AppError], ...] = (),
    view: str | None = None,
    rest_path: str | None = None,
) -> Operation:
    """Declare a query; `view` or `rest_path` exposes it over REST, otherwise it is MCP-only."""
    return Operation(name, "query", input, output, handler, description, errors, view, rest_path)


async def execute(op: Operation, principal: Principal, data: BaseModel) -> BaseModel:
    """Run one operation in its own session; a command commits once, idempotently."""
    async with open_session() as session:
        ctx = Context(session=session, principal=principal, settings=get_settings(), now=utcnow())
        try:
            if op.kind == "query":
                return await op.handler(ctx, data)
            return await _run_command(op, ctx, data)
        except BaseException:
            await session.rollback()
            raise


async def _run_command(op: Operation, ctx: Context, data: BaseModel) -> BaseModel:
    key = getattr(data, "idempotency_key", None)
    if key:
        stored = await idempotency.replay(ctx.session, key, op.name)
        if stored is not None:
            return op.response_model.model_validate(stored)
    outcome: Outcome[Any] = await op.handler(ctx, data)
    response = op.response_model(
        result=outcome.result, effects=Effects(days=sorted(outcome.days)), warnings=outcome.warnings
    )
    if key:
        idempotency.remember(ctx.session, key, op.name, response.model_dump(mode="json"))
    await ctx.session.commit()
    return response


def error_response(exc: BaseException) -> JSONResponse:
    """Any exception as the JSON error body with its status."""
    error = to_app_error(exc)
    headers = {"WWW-Authenticate": "Bearer"} if isinstance(error, Unauthorized) else None
    return JSONResponse(error.body().model_dump(), status_code=error.status, headers=headers)


class AppRoute(APIRoute):
    """A route whose every failure, including validation and auth, becomes an ErrorBody."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except Exception as exc:
                return error_response(exc)

        return guarded


def _endpoint(op: Operation) -> Callable[..., Awaitable[BaseModel]]:
    async def endpoint(data: BaseModel, principal: Principal) -> BaseModel:
        return await execute(op, principal, data)

    location = Body() if op.kind == "command" else Query()
    endpoint.__signature__ = inspect.Signature(
        [
            inspect.Parameter(
                "data", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=Annotated[op.input, location]
            ),
            inspect.Parameter(
                "principal",
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=Annotated[Principal, Depends(rest_principal)],
            ),
        ],
        return_annotation=op.response_model,
    )
    return endpoint


@dataclass(frozen=True)
class FeatureApi:
    """A feature's mini API: its operations, extra schemas, and an optional lifespan."""

    name: str
    operations: tuple[Operation, ...]
    schemas: dict[str, type[BaseModel]] = field(default_factory=dict)
    lifespan: Lifespan | None = None

    def router(self) -> APIRouter:
        """The REST routes of every operation that has one."""
        router = APIRouter(route_class=AppRoute, tags=[self.name], lifespan=self.lifespan)
        for op in self.operations:
            if op.rest is None:
                continue
            method, path = op.rest
            router.add_api_route(
                path,
                _endpoint(op),
                methods=[method],
                name=op.name,
                description=op.description,
                response_model=op.response_model,
                responses=error_responses((*BASE_ERRORS, *op.errors)),
            )
        return router


class SchemasOut(BaseModel):
    """JSON Schemas of every command input, query input and extra model."""

    commands: dict[str, dict[str, Any]]
    queries: dict[str, dict[str, Any]]
    payloads: dict[str, dict[str, Any]]


def schemas_api(apis: Sequence[FeatureApi]) -> FeatureApi:
    """A FeatureApi with get_schemas, describing the given APIs and itself."""

    async def get_schemas(ctx: Context, data: EmptyQuery) -> SchemasOut:
        return snapshot

    op = query(
        "get_schemas",
        EmptyQuery,
        SchemasOut,
        get_schemas,
        "JSON Schemas of every command, query and event payload kind.",
        rest_path="/schemas",
    )
    operations = [*(o for api in apis for o in api.operations), op]
    snapshot = SchemasOut(
        commands={o.name: o.input.model_json_schema() for o in operations if o.kind == "command"},
        queries={o.name: o.input.model_json_schema() for o in operations if o.kind == "query"},
        payloads={name: model.model_json_schema() for api in apis for name, model in api.schemas.items()},
    )
    return FeatureApi(name="schemas", operations=(op,))


def fallback_router() -> APIRouter:
    """Bound last: any unmatched path answers with a not_found ErrorBody."""
    router = APIRouter(route_class=AppRoute)

    @router.api_route(
        "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False
    )
    async def unmatched(path: str) -> None:
        raise NotFound(f"no route /{path}")

    return router
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_endpoints.py`: `13 passed`)

If `test_openapi_documents_declared_errors` fails because FastAPI keys `responses` by
int: `error_responses` returns int keys, and FastAPI serialises them as strings in
`openapi.json`, so the assertion on string keys is correct. Fix the helper, not the test.

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(helpers): operations served as REST routes with one error model

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: MCP, health, main and app-level test clients

**Files:**
- Create: `backend/app/helpers/mcp.py`, `backend/app/health.py`, `backend/app/main.py`, `backend/tests/clients.py`
- Modify: `backend/tests/conftest.py` (import `app.main` instead of `app.helpers.idempotency`; add the `rest` and `mcp` fixtures)
- Test: `backend/tests/helpers/test_mcp.py`, `backend/tests/test_app.py`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces:
  - `build_mcp_server(apis) -> MCPServer`
  - `mcp_router(apis) -> APIRouter`, which routes `/mcp` and
    `/.well-known/oauth-protected-resource/mcp` and carries the session manager's lifespan
  - `health.router` with `GET /health -> Health`: 200 when the database answers, 503 with
    `status: degraded` otherwise
  - `app.main.FEATURES: tuple[FeatureApi, ...]`, `create_app() -> FastAPI`, `app`
  - `tests/clients.py`: `rpc(client, method, params=None, token=None) -> dict`,
    `call_tool(client, name, arguments) -> dict`,
    `call_tool_error(client, name, arguments) -> dict`,
    `app_client(app, token) -> AbstractAsyncContextManager[httpx.AsyncClient]`
  - fixtures: `rest` (an httpx client on `create_app()` with an app token, no lifespan) and
    `mcp` (a zero-argument factory; use it as `async with mcp() as client:`)

Every later feature task adds its API to `FEATURES`. Nothing else in `main.py` ever changes.

- [ ] **Step 1: Write the test client helpers, fixtures and failing tests**

`backend/tests/clients.py`:

```python
"""Drive the app over ASGI: plain REST, and MCP JSON-RPC over Streamable HTTP."""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI

from tests.tokens import mcp_token

MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def _envelope(response: httpx.Response) -> dict[str, Any]:
    if "text/event-stream" in response.headers.get("content-type", ""):
        lines = [line.removeprefix("data:").strip() for line in response.text.splitlines() if line.startswith("data:")]
        return json.loads(lines[-1])
    return response.json()


async def rpc(
    client: httpx.AsyncClient, method: str, params: dict[str, Any] | None = None, token: str | None = None
) -> dict[str, Any]:
    """One JSON-RPC call to /mcp; returns its result, failing on a JSON-RPC error."""
    headers = dict(MCP_HEADERS)
    headers["Authorization"] = f"Bearer {token or mcp_token()}"
    response = await client.post(
        "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, headers=headers
    )
    response.raise_for_status()
    envelope = _envelope(response)
    assert "error" not in envelope, envelope.get("error")
    return envelope["result"]


async def call_tool(client: httpx.AsyncClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """A successful tool call's structured content."""
    result = await rpc(client, "tools/call", {"name": name, "arguments": arguments})
    assert not result.get("isError"), result
    return result["structuredContent"]


async def call_tool_error(client: httpx.AsyncClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """A failed tool call's ErrorBody."""
    result = await rpc(client, "tools/call", {"name": name, "arguments": arguments})
    assert result["isError"] is True, result
    return json.loads(result["content"][0]["text"])


@asynccontextmanager
async def app_client(app: FastAPI, token: str | None = None) -> AsyncIterator[httpx.AsyncClient]:
    """A client with the app's lifespan running (needed for MCP)."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", headers=headers) as client:
            yield client
```

In `backend/tests/conftest.py`, replace `import app.helpers.idempotency  # noqa: E402, F401`
with:

```python
import app.main  # noqa: E402, F401
```

Then append:

```python
import httpx  # noqa: E402

from app.main import create_app  # noqa: E402
from tests.clients import app_client  # noqa: E402
from tests.tokens import app_token  # noqa: E402


@pytest_asyncio.fixture
async def rest(db) -> AsyncIterator[httpx.AsyncClient]:
    """REST client on the full app, authenticated as the owner via daily2-app."""
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver", headers={"Authorization": f"Bearer {app_token()}"}
    ) as client:
        yield client


@pytest.fixture
def mcp(db):
    """Factory for an MCP-capable client; enter it inside the test (`async with mcp() as c`),
    because the MCP session manager must start and stop in the same task."""
    return lambda: app_client(create_app())
```

`backend/tests/helpers/test_mcp.py`:

```python
from fastapi import FastAPI

from app.helpers.endpoints import schemas_api
from app.helpers.mcp import mcp_router
from tests.clients import app_client, call_tool, call_tool_error, rpc
from tests.conftest import requires_db
from tests.helpers.toy import TOY
from tests.tokens import app_token

pytestmark = requires_db


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(mcp_router((TOY, schemas_api((TOY,)))))
    return app


async def test_every_operation_is_a_tool_with_flattened_arguments(db):
    async with app_client(_app()) as client:
        tools = {tool["name"]: tool for tool in (await rpc(client, "tools/list"))["tools"]}
    assert set(tools) == {"note_it", "echo", "secret_echo", "get_schemas"}
    note = tools["note_it"]
    assert set(note["inputSchema"]["properties"]) == {"text", "fail", "idempotency_key"}
    assert note["inputSchema"]["required"] == ["text"]
    assert note["annotations"]["readOnlyHint"] is False
    assert tools["echo"]["annotations"]["readOnlyHint"] is True


async def test_tools_return_the_same_shapes_as_rest(db):
    async with app_client(_app()) as client:
        body = await call_tool(client, "note_it", {"text": "from claude"})
        assert body["result"]["text"] == "from claude"
        assert body["warnings"] == ["toy"]
        echoed = await call_tool(client, "secret_echo", {"word": "x", "times": 2})
    assert echoed == {"words": ["x", "x"], "source": "claude"}


async def test_tool_errors_carry_the_error_body(db):
    async with app_client(_app()) as client:
        error = await call_tool_error(client, "note_it", {"text": "x", "fail": "not_found"})
        assert error == {"code": "not_found", "message": "no such note", "field": "text"}
        hidden = await call_tool_error(client, "note_it", {"text": "x", "fail": "boom"})
    assert hidden["code"] == "internal"


async def test_mcp_rejects_missing_and_foreign_tokens(db):
    async with app_client(_app()) as client:
        missing = await client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert missing.status_code == 401
        assert "resource_metadata" in missing.headers["www-authenticate"]
        foreign = await client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={"Authorization": f"Bearer {app_token()}", "Accept": "application/json, text/event-stream"},
        )
        assert foreign.status_code == 401


async def test_protected_resource_metadata_advertises_openid(db):
    async with app_client(_app()) as client:
        metadata = (await client.get("/.well-known/oauth-protected-resource/mcp")).json()
    assert metadata["resource"] == "http://testserver/mcp"
    assert metadata["scopes_supported"] == ["openid"]
```

`backend/tests/test_app.py`:

```python
from contextlib import asynccontextmanager

import httpx

from app.helpers.database import override_session_provider
from app.main import create_app
from tests.clients import rpc
from tests.conftest import requires_db

pytestmark = requires_db


async def test_health_reports_version_uptime_and_database(rest):
    response = await rest.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"]["ok"] is True
    assert body["version"] == "0.1.0"


async def test_health_is_degraded_without_a_database(db):
    @asynccontextmanager
    async def broken():
        raise ConnectionError("db down")
        yield

    override_session_provider(broken)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://t") as client:
        response = await client.get("/health")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"


async def test_schemas_and_unknown_routes(rest):
    assert "get_schemas" in (await rest.get("/api/v2/schemas")).json()["queries"]
    missing = await rest.get("/api/v2/views/does-not-exist")
    assert (missing.status_code, missing.json()["code"]) == (404, "not_found")


async def test_mcp_is_bound(mcp):
    async with mcp() as client:
        tools = await rpc(client, "tools/list")
    assert "get_schemas" in {tool["name"] for tool in tools["tools"]}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/helpers/test_mcp.py tests/test_app.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 3: Implement**

`backend/app/helpers/mcp.py`:

```python
"""MCP: every operation becomes a tool with flattened arguments; extra schemas become resources."""

import inspect
import json
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, FastAPI
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field
from starlette.routing import Route

from app.helpers.auth import McpTokenVerifier, mcp_principal
from app.helpers.config import app_version, get_settings
from app.helpers.endpoints import FeatureApi, Operation, execute
from app.helpers.errors import to_app_error

INSTRUCTIONS = (
    "daily is the owner's health journal and diet system. Start every conversation with "
    "get_context. Log facts with log_events; never guess food ids, find them with find_food."
)


def _parameters(op: Operation) -> list[inspect.Parameter]:
    parameters = []
    for name, info in op.input.model_fields.items():
        metadata = list(info.metadata)
        if info.description:
            metadata.append(Field(description=info.description))
        annotation = Annotated[(info.annotation, *metadata)] if metadata else info.annotation
        default = inspect.Parameter.empty if info.is_required() else info.get_default(call_default_factory=True)
        parameters.append(
            inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY, annotation=annotation, default=default)
        )
    return parameters


def _tool(op: Operation) -> Any:
    async def tool(**arguments: Any) -> dict[str, Any]:
        try:
            data = op.input.model_validate(arguments)
            result = await execute(op, mcp_principal(), data)
        except Exception as exc:
            raise ToolError(to_app_error(exc).body().model_dump_json()) from exc
        return result.model_dump(mode="json")

    tool.__signature__ = inspect.Signature(_parameters(op), return_annotation=dict[str, Any])
    tool.__name__ = op.name
    tool.__doc__ = op.description
    return tool


def _add_schema_resource(server: MCPServer, name: str, model: type[BaseModel]) -> None:
    body = json.dumps(model.model_json_schema())

    def read() -> str:
        return body

    server.resource(f"daily://schema/{name}", name=f"schema-{name}", mime_type="application/json")(read)


def build_mcp_server(apis: Sequence[FeatureApi]) -> MCPServer:
    """An MCP server with one tool per operation, guarded by Keycloak."""
    settings = get_settings()
    server = MCPServer(
        "daily",
        instructions=INSTRUCTIONS,
        version=app_version(),
        token_verifier=McpTokenVerifier(settings),
        auth=AuthSettings(
            issuer_url=settings.keycloak_issuer,
            resource_server_url=settings.mcp_resource_url,
            validate_token_resource=True,
            required_scopes=["openid"],
        ),
    )
    for api in apis:
        for op in api.operations:
            server.add_tool(
                _tool(op),
                name=op.name,
                description=op.description,
                annotations=ToolAnnotations(
                    read_only_hint=op.kind == "query",
                    destructive_hint=op.destructive,
                    open_world_hint=False,
                ),
            )
        for name, model in api.schemas.items():
            _add_schema_resource(server, name, model)
    return server


def mcp_router(apis: Sequence[FeatureApi]) -> APIRouter:
    """Routes /mcp and its protected-resource metadata; carries the session manager's lifespan."""
    server = build_mcp_server(apis)
    settings = get_settings()
    asgi = server.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=settings.mcp_allowed_hosts, allowed_origins=settings.mcp_allowed_origins
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with server.session_manager.run():
            yield

    router = APIRouter(lifespan=lifespan)
    router.routes.append(Route("/mcp", endpoint=asgi))
    router.routes.append(Route("/.well-known/oauth-protected-resource/mcp", endpoint=asgi, methods=["GET"]))
    return router
```

`backend/app/health.py`:

```python
"""GET /health: version, uptime and database reachability, for probes and monitoring."""

import time
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.helpers.config import app_version
from app.helpers.database import open_session, ping

router = APIRouter(tags=["health"])
_started = time.monotonic()


class DatabaseHealth(BaseModel):
    """Whether the database answered, and how fast."""

    ok: bool
    latency_ms: float | None


class Health(BaseModel):
    """The health metric document."""

    status: Literal["ok", "degraded"]
    version: str
    uptime_seconds: float
    database: DatabaseHealth


@router.get("/health", response_model=Health, responses={503: {"model": Health}})
async def health() -> JSONResponse:
    """200 when the database answers, 503 (degraded) when it does not."""
    started = time.perf_counter()
    try:
        async with open_session() as session:
            await ping(session)
        database = DatabaseHealth(ok=True, latency_ms=round((time.perf_counter() - started) * 1000, 1))
    except Exception:
        database = DatabaseHealth(ok=False, latency_ms=None)
    body = Health(
        status="ok" if database.ok else "degraded",
        version=app_version(),
        uptime_seconds=round(time.monotonic() - _started, 1),
        database=database,
    )
    return JSONResponse(body.model_dump(), status_code=200 if database.ok else 503)
```

`backend/app/main.py`:

```python
"""Binds the routers: health, every feature, schemas, MCP, and the fallback."""

from fastapi import FastAPI

from app import health
from app.helpers.config import app_version
from app.helpers.endpoints import FeatureApi, fallback_router, schemas_api
from app.helpers.lifespan import lifespan
from app.helpers.mcp import mcp_router

FEATURES: tuple[FeatureApi, ...] = ()


def create_app() -> FastAPI:
    """The application with every router bound."""
    app = FastAPI(title="daily", version=app_version(), lifespan=lifespan)
    apis = (*FEATURES, schemas_api(FEATURES))
    app.include_router(health.router)
    for api in apis:
        app.include_router(api.router(), prefix="/api/v2")
    app.include_router(mcp_router(apis))
    app.include_router(fallback_router())
    return app


app = create_app()
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_mcp.py`: `5 passed`, `test_app.py`: `4 passed`)

If `test_every_operation_is_a_tool_with_flattened_arguments` shows the arguments nested
under `arguments` instead of flattened, the SDK ignored `__signature__`. Confirm with
`inspect.signature(tool)` in a REPL. `func_metadata` calls `inspect.signature(fn,
eval_str=True)`, which honours `__signature__`.

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat: MCP from operations, /health, and a main that only binds routers

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 8: Feature `profile`

**Files:**
- Create: `backend/app/features/profile/__init__.py` (empty), `models.py`, `exceptions.py`, `functions.py`, `routers.py`, `profile.py`
- Modify: `backend/app/main.py` (add the API to `FEATURES`)
- Test: `backend/tests/features/__init__.py` (empty), `backend/tests/features/profile/__init__.py` (empty), `backend/tests/features/profile/test_profile.py`

**Interfaces:**
- Consumes: helpers (Tasks 1–7).
- Produces:
  - Tables `ProfileVersion` (`profile_version`) and `SourcePreference` (`source_preference`)
  - Models `Sex`, `ProfileUpdate`, `ProfileOut`, `SourcePreferenceIn`, `SourcePreferenceOut`
  - `profile_at(session, moment: datetime) -> ProfileVersion | None`
  - `current_profile(session, now: datetime) -> ProfileOut | None`
  - `profile_for(session, moment: datetime) -> ProfileVersion | None`: the version valid at
    the moment, falling back to the earliest version for moments before the first one. A
    body description with no history applies backwards; this is what day views use.
  - `timezone_at(session, moment: datetime, default: str) -> str`
  - `preferred_sources(session) -> dict[str, list[str]]`
  - `list_source_preferences(session) -> list[SourcePreferenceOut]`
  - Commands `update_profile` and `set_source_preference`
  - `app.features.profile.profile.api: FeatureApi`

- [ ] **Step 1: Write the failing tests**

`backend/tests/features/profile/test_profile.py`:

```python
from datetime import UTC, datetime, timedelta

from app.features.profile.functions import profile_for, timezone_at
from app.features.profile.models import ProfileVersion
from tests.clients import call_tool
from tests.conftest import requires_db

pytestmark = requires_db


async def test_first_update_fills_defaults(rest):
    body = (await rest.post("/api/v2/commands/update_profile", json={"height_cm": 180})).json()
    profile = body["result"]
    assert profile["height_cm"] == 180
    assert profile["timezone"] == "Europe/Berlin"
    assert (profile["protein_g_per_kg"], profile["fat_g_per_kg_min"]) == (1.8, 0.8)
    assert len(body["effects"]["days"]) == 1


async def test_only_sent_fields_change_and_null_clears(rest):
    await rest.post("/api/v2/commands/update_profile", json={"height_cm": 180, "sex": "male"})
    second = (await rest.post("/api/v2/commands/update_profile", json={"sex": None})).json()["result"]
    assert second["height_cm"] == 180
    assert second["sex"] is None


async def test_goal_needs_weight_and_date_together(rest):
    response = await rest.post("/api/v2/commands/update_profile", json={"goal_weight_kg": 77})
    assert response.status_code == 422
    assert response.json() == {
        "code": "validation",
        "message": "goal_weight_kg and goal_date must be set together",
        "field": "goal_date",
    }
    ok = await rest.post("/api/v2/commands/update_profile", json={"goal_weight_kg": 77, "goal_date": "2027-01-01"})
    assert ok.status_code == 200


async def test_required_fields_cannot_be_cleared_and_timezone_must_exist(rest):
    cleared = await rest.post("/api/v2/commands/update_profile", json={"timezone": None})
    assert (cleared.status_code, cleared.json()["field"]) == (422, "timezone")
    unknown = await rest.post("/api/v2/commands/update_profile", json={"timezone": "Mars/Base"})
    assert (unknown.status_code, unknown.json()["field"]) == (422, "timezone")


async def test_timezone_at_uses_the_version_valid_at_that_moment(db):
    now = datetime(2026, 9, 30, 12, tzinfo=UTC)
    db.add(ProfileVersion(valid_from=now, timezone="Asia/Tokyo", protein_g_per_kg=1.8, fat_g_per_kg_min=0.8))
    await db.flush()
    assert await timezone_at(db, now - timedelta(days=1), "Europe/Berlin") == "Europe/Berlin"
    assert await timezone_at(db, now + timedelta(days=1), "Europe/Berlin") == "Asia/Tokyo"
    assert (await profile_for(db, now - timedelta(days=1))).timezone == "Asia/Tokyo"


async def test_source_preference_is_upserted_through_mcp(mcp):
    async with mcp() as client:
        await call_tool(client, "set_source_preference", {"metric": "steps", "sources": ["app"]})
        body = await call_tool(client, "set_source_preference", {"metric": "steps", "sources": ["ring", "app"]})
    assert body["result"] == {"metric": "steps", "sources": ["ring", "app"]}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/profile -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.features.profile'`

- [ ] **Step 3: Implement**

`backend/app/features/profile/models.py`:

```python
"""Profile tables and the models only the profile feature defines."""

import uuid
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base
from app.helpers.models import CommandInput

Sex = Literal["male", "female"]

PROFILE_FIELDS = (
    "timezone",
    "height_cm",
    "birth_date",
    "sex",
    "goal_weight_kg",
    "goal_date",
    "protein_g_per_kg",
    "fat_g_per_kg_min",
    "gym_sessions_per_week",
)
REQUIRED_FIELDS = ("timezone", "protein_g_per_kg", "fat_g_per_kg_min")


class ProfileVersion(Base):
    """One version of the owner's profile, valid from `valid_from` until the next one."""

    __tablename__ = "profile_version"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    valid_from: Mapped[datetime] = mapped_column(index=True)
    timezone: Mapped[str] = mapped_column(sa.String(64))
    height_cm: Mapped[float | None]
    birth_date: Mapped[date | None]
    sex: Mapped[str | None] = mapped_column(sa.String(10))
    goal_weight_kg: Mapped[float | None]
    goal_date: Mapped[date | None]
    protein_g_per_kg: Mapped[float]
    fat_g_per_kg_min: Mapped[float]
    gym_sessions_per_week: Mapped[float | None]


class SourcePreference(Base):
    """Which source wins when several report the same metric, best first."""

    __tablename__ = "source_preference"

    metric: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    sources: Mapped[list[Any]]


class ProfileUpdate(CommandInput):
    """Only the fields sent change; null clears an optional field."""

    timezone: str | None = Field(default=None, min_length=1, max_length=64, description="IANA name, e.g. Europe/Berlin.")
    height_cm: float | None = Field(default=None, gt=50, lt=260)
    birth_date: date | None = None
    sex: Sex | None = None
    goal_weight_kg: float | None = Field(default=None, gt=20, lt=400)
    goal_date: date | None = None
    protein_g_per_kg: float | None = Field(default=None, gt=0, le=4)
    fat_g_per_kg_min: float | None = Field(default=None, gt=0, le=3)
    gym_sessions_per_week: float | None = Field(default=None, ge=0, le=14)

    @field_validator("timezone")
    @classmethod
    def _known_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("unknown IANA timezone") from exc
        return value


class ProfileOut(BaseModel):
    """A profile version."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    valid_from: datetime
    timezone: str
    height_cm: float | None
    birth_date: date | None
    sex: Sex | None
    goal_weight_kg: float | None
    goal_date: date | None
    protein_g_per_kg: float
    fat_g_per_kg_min: float
    gym_sessions_per_week: float | None


class SourcePreferenceIn(CommandInput):
    """Set the source order for one metric, e.g. steps: [ring, health-connect, app]."""

    metric: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    sources: list[str] = Field(min_length=1, max_length=10)


class SourcePreferenceOut(BaseModel):
    """A metric's source order."""

    metric: str
    sources: list[str]
```

`backend/app/features/profile/exceptions.py`:

```python
"""Every error the profile feature raises."""

from app.helpers.errors import ValidationFailed


class GoalIncomplete(ValidationFailed):
    """A goal needs both a weight and a date."""

    def __init__(self) -> None:
        super().__init__("goal_weight_kg and goal_date must be set together", "goal_date")


class FieldRequired(ValidationFailed):
    """A required profile field was sent as null."""

    def __init__(self, field: str) -> None:
        super().__init__(f"{field} cannot be cleared", field)
```

`backend/app/features/profile/functions.py`:

```python
"""Profile logic: versioned updates, the timezone at a moment, and source preferences."""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.profile.exceptions import FieldRequired, GoalIncomplete
from app.features.profile.models import (
    PROFILE_FIELDS,
    REQUIRED_FIELDS,
    ProfileOut,
    ProfileUpdate,
    ProfileVersion,
    SourcePreference,
    SourcePreferenceIn,
    SourcePreferenceOut,
)
from app.helpers.endpoints import Context
from app.helpers.responses import Outcome
from app.helpers.time import local_day

DEFAULTS = {"protein_g_per_kg": 1.8, "fat_g_per_kg_min": 0.8}


async def profile_at(session: AsyncSession, moment: datetime) -> ProfileVersion | None:
    """The version valid at a moment."""
    return await session.scalar(
        select(ProfileVersion)
        .where(ProfileVersion.valid_from <= moment)
        .order_by(ProfileVersion.valid_from.desc())
        .limit(1)
    )


async def profile_for(session: AsyncSession, moment: datetime) -> ProfileVersion | None:
    """The version valid at a moment; before the first version, the first version."""
    row = await profile_at(session, moment)
    if row is not None:
        return row
    return await session.scalar(select(ProfileVersion).order_by(ProfileVersion.valid_from).limit(1))


async def current_profile(session: AsyncSession, now: datetime) -> ProfileOut | None:
    """The version valid now, as its output model."""
    row = await profile_at(session, now)
    return ProfileOut.model_validate(row) if row else None


async def timezone_at(session: AsyncSession, moment: datetime, default: str) -> str:
    """The owner's timezone at a moment, or the default before any profile exists."""
    row = await profile_at(session, moment)
    return row.timezone if row else default


async def update_profile(ctx: Context, data: ProfileUpdate) -> Outcome[ProfileOut]:
    """Write a new version from the current one plus the fields sent."""
    current = await profile_at(ctx.session, ctx.now)
    if current is not None:
        values = {name: getattr(current, name) for name in PROFILE_FIELDS}
    else:
        values = {name: None for name in PROFILE_FIELDS} | {"timezone": ctx.settings.default_timezone} | DEFAULTS
    changes = data.model_dump(exclude_unset=True, exclude={"idempotency_key"})
    for name in REQUIRED_FIELDS:
        if name in changes and changes[name] is None:
            raise FieldRequired(name)
    values.update(changes)
    if (values["goal_weight_kg"] is None) != (values["goal_date"] is None):
        raise GoalIncomplete()
    row = ProfileVersion(valid_from=ctx.now, **values)
    ctx.session.add(row)
    await ctx.session.flush()
    return Outcome(ProfileOut.model_validate(row), days={local_day(ctx.now, row.timezone)})


async def preferred_sources(session: AsyncSession) -> dict[str, list[str]]:
    """Every metric's source order."""
    rows = await session.scalars(select(SourcePreference))
    return {row.metric: list(row.sources) for row in rows}


async def list_source_preferences(session: AsyncSession) -> list[SourcePreferenceOut]:
    """Every metric's source order, as output models."""
    return [SourcePreferenceOut(metric=m, sources=s) for m, s in sorted((await preferred_sources(session)).items())]


async def set_source_preference(ctx: Context, data: SourcePreferenceIn) -> Outcome[SourcePreferenceOut]:
    """Create or replace one metric's source order."""
    row = await ctx.session.get(SourcePreference, data.metric)
    if row is None:
        ctx.session.add(SourcePreference(metric=data.metric, sources=data.sources))
    else:
        row.sources = data.sources
    await ctx.session.flush()
    return Outcome(SourcePreferenceOut(metric=data.metric, sources=data.sources))
```

`backend/app/features/profile/routers.py`:

```python
"""The profile feature's endpoints."""

from app.features.profile import functions
from app.features.profile.exceptions import FieldRequired, GoalIncomplete
from app.features.profile.models import ProfileOut, ProfileUpdate, SourcePreferenceIn, SourcePreferenceOut
from app.helpers.endpoints import command

OPERATIONS = (
    command(
        "update_profile",
        ProfileUpdate,
        ProfileOut,
        functions.update_profile,
        "Write a new profile version: body data, timezone and goal. Only the fields sent change; "
        "null clears an optional field.",
        errors=(GoalIncomplete, FieldRequired),
    ),
    command(
        "set_source_preference",
        SourcePreferenceIn,
        SourcePreferenceOut,
        functions.set_source_preference,
        "Set which source wins for a metric when several report it, best first "
        "(e.g. steps: ring, health-connect, app).",
    ),
)
```

`backend/app/features/profile/profile.py`:

```python
"""The profile feature's API."""

from app.features.profile.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(name="profile", operations=OPERATIONS)
```

In `backend/app/main.py`, add the import `from app.features.profile.profile import api as profile` and set:

```python
FEATURES: tuple[FeatureApi, ...] = (profile,)
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_profile.py`: `6 passed`)

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(profile): versioned profile and source preferences

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Feature `catalog`

**Files:**
- Create: `backend/app/features/catalog/__init__.py` (empty), `models.py`, `exceptions.py`, `services.py`, `functions.py`, `routers.py`, `catalog.py`
- Modify: `backend/app/main.py` (add the API to `FEATURES`)
- Test: `backend/tests/features/catalog/__init__.py` (empty), `backend/tests/features/catalog/fakes.py`, `backend/tests/features/catalog/test_services.py`, `backend/tests/features/catalog/test_foods.py`, `backend/tests/features/catalog/test_recipes.py`

**Interfaces:**
- Consumes: helpers; `services` (Task 5).
- Produces:
  - Tables `Food`, `FoodVersion`, `Recipe` and `RecipeVersion`
  - Models `FoodKind`, `Per100` (with `.for_grams(grams, kind) -> Nutrients`), `FoodOut`,
    `FoodSave`, `FoodImport`, `FoodSearch`, `RemoteFood`, `FoodSearchOut`,
    `RecipeItemIn`, `RecipeSave`, `RecipeItemOut`, `RecipeOut`, `RecipeListQuery`,
    `RecipeSummary`, `RecipeList`, `SnapshotItem`
  - `OffProduct`, `parse_product(raw) -> OffProduct`, `OpenFoodFactsClient`,
    `openfoodfacts() -> OpenFoodFactsClient`
  - For the journal: `snapshot(session, items: Sequence[tuple[UUID, float]], field: str = "items") -> list[SnapshotItem]`
    and `recipe_items(session, recipe_id, portions, field="recipe_id") -> tuple[UUID, list[tuple[UUID, float]]]`
  - Operations `import_food`, `save_food`, `archive_food`, `save_recipe`,
    `archive_recipe`, `find_food` (view `catalog`), `get_food` (view `food`),
    `get_recipe` (view `recipe`) and `list_recipes` (view `recipes`)
  - Exceptions `FoodNotFound`, `RecipeNotFound`, `FoodArchived`, `RecipeArchived`,
    `MissingForCreate`, `NotOnOpenFoodFacts` and `NoNutritionData`

- [ ] **Step 1: Write the fake and the failing tests**

`backend/tests/features/catalog/fakes.py`:

```python
"""An in-memory Open Food Facts stand-in."""

from app.features.catalog.models import Per100
from app.features.catalog.services import OffProduct
from app.helpers.errors import Upstream

SKYR = OffProduct(barcode="4056489012788", name="Skyr", brand="Milbona", per_100=Per100(kcal=62, protein_g=11, carbs_g=4, fat_g=0.2))
MILK = OffProduct(barcode="22130112", name="Milch 1,5%", brand="Milfina", per_100=Per100(kcal=46, protein_g=3.4, carbs_g=4.8, fat_g=1.5))
NO_DATA = OffProduct(barcode="1111", name="Mystery", brand=None, per_100=None)


class FakeOff:
    """Serves fixed products; `down=True` fails every call like an outage."""

    def __init__(self, products: list[OffProduct] | None = None, down: bool = False) -> None:
        self.products = {p.barcode: p for p in (products or [SKYR, MILK, NO_DATA])}
        self.down = down

    async def search(self, query: str, size: int = 20) -> list[OffProduct]:
        if self.down:
            raise Upstream("Open Food Facts did not answer")
        return [p for p in self.products.values() if query.lower() in p.name.lower()]

    async def get_product(self, barcode: str) -> OffProduct | None:
        if self.down:
            raise Upstream("Open Food Facts did not answer")
        return self.products.get(barcode)
```

`backend/tests/features/catalog/test_services.py`:

```python
import httpx
import pytest

from app.features.catalog.services import OpenFoodFactsClient, parse_product
from app.helpers.errors import Upstream


def test_parse_product_reads_kcal_or_converts_kilojoules():
    direct = parse_product({"code": "1", "product_name": "A", "brands": "X, Y", "nutriments": {"energy-kcal_100g": 100, "proteins_100g": "7.5"}})
    assert (direct.name, direct.brand, direct.per_100.kcal, direct.per_100.protein_g) == ("A", "X", 100, 7.5)
    converted = parse_product({"code": "2", "product_name_de": "B", "brands": ["Z"], "nutriments": {"energy_100g": 418.4}})
    assert (converted.name, converted.brand, converted.per_100.kcal) == ("B", "Z", 100)


def test_parse_product_without_energy_or_with_nonsense_has_no_nutrients():
    assert parse_product({"code": "3", "nutriments": {}}).per_100 is None
    assert parse_product({"code": "4", "nutriments": {"energy-kcal_100g": 99999}}).per_100 is None
    assert parse_product({"code": "5"}).name == "5"


async def test_client_search_product_and_failures():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["user-agent"].startswith("daily2")
        if request.url.path == "/search":
            return httpx.Response(200, json={"hits": [{"code": "9", "product_name": "Skyr", "nutriments": {"energy-kcal_100g": 62}}]})
        if request.url.path.endswith("/9"):
            return httpx.Response(200, json={"status": 1, "product": {"code": "9", "product_name": "Skyr", "nutriments": {"energy-kcal_100g": 62}}})
        if request.url.path.endswith("/404"):
            return httpx.Response(404, json={"status": 0})
        return httpx.Response(500)

    client = OpenFoodFactsClient(httpx.AsyncClient(transport=httpx.MockTransport(handler)), "http://off/search", "http://off/api/v2/product", "daily2 test")
    assert [p.barcode for p in await client.search("skyr")] == ["9"]
    assert (await client.get_product("9")).name == "Skyr"
    assert await client.get_product("404") is None
    with pytest.raises(Upstream):
        await client.get_product("500")
    await client.aclose()
```

`backend/tests/features/catalog/test_foods.py`:

```python
import pytest

from app.features.catalog.functions import snapshot
from app.features.catalog.exceptions import FoodNotFound
from app.helpers.services import services
from tests.clients import call_tool
from tests.conftest import requires_db
from tests.features.catalog.fakes import FakeOff

pytestmark = requires_db


@pytest.fixture(autouse=True)
def off():
    fake = FakeOff()
    services.override("openfoodfacts", fake)
    return fake


async def _manual(rest, **overrides):
    body = {"name": "Eier", "unit_name": "Stück", "unit_grams": 58, "per_100": {"kcal": 143, "protein_g": 12.6, "fat_g": 9.9}} | overrides
    return (await rest.post("/api/v2/commands/save_food", json=body)).json()["result"]


async def test_import_food_caches_an_open_food_facts_product_once(rest):
    first = (await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})).json()["result"]
    again = (await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})).json()["result"]
    assert first["id"] == again["id"]
    assert (first["source"], first["per_100"]["kcal"], first["versions"]) == ("off", 62, 1)


async def test_import_food_errors(rest, off):
    missing = await rest.post("/api/v2/commands/import_food", json={"barcode": "999999"})
    assert (missing.status_code, missing.json()["code"], missing.json()["field"]) == (404, "not_found", "barcode")
    empty = await rest.post("/api/v2/commands/import_food", json={"barcode": "1111"})
    assert (empty.status_code, empty.json()["field"]) == (422, "barcode")
    off.down = True
    down = await rest.post("/api/v2/commands/import_food", json={"barcode": "22130112"})
    assert (down.status_code, down.json()["code"]) == (503, "upstream")


async def test_save_food_creates_updates_and_versions_nutrients(rest):
    food = await _manual(rest)
    assert (food["source"], food["versions"], food["unit_grams"]) == ("manual", 1, 58)
    renamed = (await rest.post("/api/v2/commands/save_food", json={"id": food["id"], "name": "Freiland Eier"})).json()["result"]
    assert (renamed["name"], renamed["unit_name"], renamed["versions"]) == ("Freiland Eier", "Stück", 1)
    corrected = (await rest.post("/api/v2/commands/save_food", json={"id": food["id"], "per_100": {"kcal": 150}})).json()["result"]
    assert (corrected["per_100"]["kcal"], corrected["versions"]) == (150, 2)


async def test_save_food_errors(rest):
    no_nutrients = await rest.post("/api/v2/commands/save_food", json={"name": "Salz"})
    assert (no_nutrients.status_code, no_nutrients.json()["field"]) == (422, "per_100")
    no_name = await rest.post("/api/v2/commands/save_food", json={"per_100": {"kcal": 0}})
    assert (no_name.status_code, no_name.json()["field"]) == (422, "name")
    half_unit = await rest.post("/api/v2/commands/save_food", json={"name": "X", "unit_name": "Stück", "per_100": {"kcal": 1}})
    assert half_unit.status_code == 422
    unknown = await rest.post("/api/v2/commands/save_food", json={"id": "00000000-0000-0000-0000-000000000001", "name": "X"})
    assert (unknown.status_code, unknown.json()["code"]) == (404, "not_found")


async def test_archived_foods_cannot_be_edited_and_leave_search(rest):
    food = await _manual(rest, name="Knoblauch")
    await rest.post("/api/v2/commands/archive_food", json={"id": food["id"]})
    edit = await rest.post("/api/v2/commands/save_food", json={"id": food["id"], "name": "K"})
    assert (edit.status_code, edit.json()["code"]) == (409, "conflict")
    found = (await rest.get("/api/v2/views/catalog", params={"q": "Knob"})).json()
    assert found["local"] == []


async def test_find_food_merges_local_and_remote_and_survives_an_outage(rest, off):
    await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})
    both = (await rest.get("/api/v2/views/catalog", params={"q": "Mil"})).json()
    assert [f["name"] for f in both["remote"]] == ["Milch 1,5%"]
    skyr = (await rest.get("/api/v2/views/catalog", params={"q": "Skyr"})).json()
    assert [f["name"] for f in skyr["local"]] == ["Skyr"]
    assert skyr["remote"] == []
    off.down = True
    outage = (await rest.get("/api/v2/views/catalog", params={"q": "Skyr"})).json()
    assert outage["remote_error"] == "Open Food Facts did not answer"
    assert len(outage["local"]) == 1


async def test_get_food_view_and_snapshot(rest, db):
    food = await _manual(rest)
    view = (await rest.get("/api/v2/views/food", params={"id": food["id"]})).json()
    assert view["name"] == "Eier"
    items = await snapshot(db, [(food["id"], 116)])
    assert (items[0].name, items[0].grams, items[0].nutrients.kcal, items[0].nutrients.fluid_ml) == ("Eier", 116, 165.88, 0)
    with pytest.raises(FoodNotFound) as caught:
        await snapshot(db, [("00000000-0000-0000-0000-000000000009", 10)])
    assert caught.value.field == "items.0.food_id"


async def test_find_food_through_mcp(mcp):
    async with mcp() as client:
        body = await call_tool(client, "find_food", {"q": "Skyr"})
    assert body["remote"][0]["usable"] is True
```

`backend/tests/features/catalog/test_recipes.py`:

```python
import pytest

from app.features.catalog.functions import recipe_items
from tests.conftest import requires_db

pytestmark = requires_db


async def _food(rest, name, kcal, protein=0.0):
    body = {"name": name, "per_100": {"kcal": kcal, "protein_g": protein}}
    return (await rest.post("/api/v2/commands/save_food", json=body)).json()["result"]


@pytest.fixture
async def bowl(rest):
    chicken = await _food(rest, "Hähnchen", 110, 23)
    rice = await _food(rest, "Reis", 350, 7)
    body = {"name": "Bowl", "serves": 2, "steps": ["Kochen", "Braten"], "items": [{"food_id": chicken["id"], "grams": 300}, {"food_id": rice["id"], "grams": 140}]}
    recipe = (await rest.post("/api/v2/commands/save_recipe", json=body)).json()["result"]
    return recipe, chicken, rice


async def test_recipe_totals_and_per_portion(bowl):
    recipe, _, _ = bowl
    assert recipe["totals"]["kcal"] == 820
    assert recipe["per_portion"]["kcal"] == 410
    assert recipe["steps"] == ["Kochen", "Braten"]
    assert recipe["versions"] == 1


async def test_saving_again_adds_a_version(rest, bowl):
    recipe, chicken, _ = bowl
    body = {"id": recipe["id"], "name": "Bowl", "serves": 1, "items": [{"food_id": chicken["id"], "grams": 150}]}
    updated = (await rest.post("/api/v2/commands/save_recipe", json=body)).json()["result"]
    assert (updated["versions"], updated["totals"]["kcal"]) == (2, 165)


async def test_recipe_errors(rest, bowl):
    recipe, chicken, _ = bowl
    unknown_food = await rest.post(
        "/api/v2/commands/save_recipe",
        json={"name": "X", "items": [{"food_id": "00000000-0000-0000-0000-000000000009", "grams": 1}]},
    )
    assert (unknown_food.status_code, unknown_food.json()["field"]) == (404, "items.0.food_id")
    await rest.post("/api/v2/commands/archive_food", json={"id": chicken["id"]})
    archived_food = await rest.post("/api/v2/commands/save_recipe", json={"name": "X", "items": [{"food_id": chicken["id"], "grams": 1}]})
    assert (archived_food.status_code, archived_food.json()["field"]) == (409, "items.0.food_id")
    await rest.post("/api/v2/commands/archive_recipe", json={"id": recipe["id"]})
    edit = await rest.post("/api/v2/commands/save_recipe", json={"id": recipe["id"], "name": "B", "items": [{"food_id": chicken["id"], "grams": 1}]})
    assert edit.status_code == 409
    missing = await rest.get("/api/v2/views/recipe", params={"id": "00000000-0000-0000-0000-000000000009"})
    assert missing.status_code == 404


async def test_list_recipes_hides_archived_unless_asked(rest, bowl):
    recipe, _, _ = bowl
    assert [r["name"] for r in (await rest.get("/api/v2/views/recipes")).json()["recipes"]] == ["Bowl"]
    await rest.post("/api/v2/commands/archive_recipe", json={"id": recipe["id"]})
    assert (await rest.get("/api/v2/views/recipes")).json()["recipes"] == []
    all_recipes = (await rest.get("/api/v2/views/recipes", params={"include_archived": True})).json()["recipes"]
    assert all_recipes[0]["archived"] is True


async def test_recipe_items_scale_to_portions(db, bowl):
    recipe, chicken, _ = bowl
    version_id, items = await recipe_items(db, recipe["id"], portions=1)
    assert str(version_id) == recipe["version_id"]
    assert (str(items[0][0]), items[0][1]) == (chicken["id"], 150)
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/catalog -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.features.catalog'`

- [ ] **Step 3: Implement the models, exceptions and services**

`backend/app/features/catalog/models.py`:

```python
"""Catalog tables and the models only the catalog feature defines."""

import uuid
from datetime import datetime
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base, CreatedAtMixin
from app.helpers.models import CommandInput, Nutrients, QueryInput, StrictModel

FoodKind = Literal["food", "drink"]


class Food(Base, CreatedAtMixin):
    """A food or drink; its nutrients live in versions."""

    __tablename__ = "food"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(sa.String(300))
    brand: Mapped[str | None] = mapped_column(sa.String(300))
    barcode: Mapped[str | None] = mapped_column(sa.String(64), unique=True)
    kind: Mapped[str] = mapped_column(sa.String(10))
    source: Mapped[str] = mapped_column(sa.String(10))
    unit_name: Mapped[str | None] = mapped_column(sa.String(32))
    unit_grams: Mapped[float | None]
    pack_grams: Mapped[float | None]
    archived_at: Mapped[datetime | None]


class FoodVersion(Base):
    """Nutrients per 100 g/ml of a food from `valid_from` on."""

    __tablename__ = "food_version"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    food_id: Mapped[uuid.UUID] = mapped_column(sa.ForeignKey("food.id"), index=True)
    valid_from: Mapped[datetime]
    kcal: Mapped[float]
    protein_g: Mapped[float | None]
    carbs_g: Mapped[float | None]
    fat_g: Mapped[float | None]
    fiber_g: Mapped[float | None]
    sugar_g: Mapped[float | None]
    salt_g: Mapped[float | None]
    source_note: Mapped[str | None] = mapped_column(sa.String(300))


class Recipe(Base, CreatedAtMixin):
    """A recipe; its content lives in versions."""

    __tablename__ = "recipe"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(sa.String(200))
    archived_at: Mapped[datetime | None]


class RecipeVersion(Base):
    """A recipe's items, portions and steps from `valid_from` on."""

    __tablename__ = "recipe_version"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    recipe_id: Mapped[uuid.UUID] = mapped_column(sa.ForeignKey("recipe.id"), index=True)
    valid_from: Mapped[datetime]
    serves: Mapped[int]
    steps: Mapped[list[Any]]
    items: Mapped[list[Any]]
    note: Mapped[str | None] = mapped_column(sa.Text)


class Per100(StrictModel):
    """Nutrient facts per 100 g (or 100 ml for drinks)."""

    kcal: float = Field(ge=0, le=1000)
    protein_g: float | None = Field(default=None, ge=0, le=100)
    carbs_g: float | None = Field(default=None, ge=0, le=100)
    fat_g: float | None = Field(default=None, ge=0, le=100)
    fiber_g: float | None = Field(default=None, ge=0, le=100)
    sugar_g: float | None = Field(default=None, ge=0, le=100)
    salt_g: float | None = Field(default=None, ge=0, le=100)

    def for_grams(self, grams: float, kind: str) -> Nutrients:
        """Absolute amounts in `grams` of this food; drinks also count as fluid."""
        factor = grams / 100
        return Nutrients(
            kcal=round(self.kcal * factor, 2),
            protein_g=round((self.protein_g or 0) * factor, 2),
            carbs_g=round((self.carbs_g or 0) * factor, 2),
            fat_g=round((self.fat_g or 0) * factor, 2),
            fiber_g=round((self.fiber_g or 0) * factor, 2),
            sugar_g=round((self.sugar_g or 0) * factor, 2),
            salt_g=round((self.salt_g or 0) * factor, 2),
            fluid_ml=round(grams, 2) if kind == "drink" else 0,
        )


class FoodOut(BaseModel):
    """A food with its current nutrients."""

    id: uuid.UUID
    name: str
    brand: str | None
    barcode: str | None
    kind: FoodKind
    source: Literal["off", "manual"]
    unit_name: str | None
    unit_grams: float | None
    pack_grams: float | None
    archived: bool
    version_id: uuid.UUID
    per_100: Per100
    versions: int


class FoodSave(CommandInput):
    """Create a food (without id) or change one (with id); on change, only the fields sent change."""

    id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=300)
    brand: str | None = Field(default=None, max_length=300)
    kind: FoodKind | None = None
    unit_name: str | None = Field(default=None, min_length=1, max_length=32, description="e.g. Stück")
    unit_grams: float | None = Field(default=None, gt=0, le=5000)
    pack_grams: float | None = Field(default=None, gt=0, le=100000)
    per_100: Per100 | None = Field(default=None, description="New nutrients create a new version.")

    @model_validator(mode="after")
    def _unit_pair(self) -> "FoodSave":
        sent = {"unit_name", "unit_grams"} & self.model_fields_set
        if len(sent) == 1 or (self.unit_name is None) != (self.unit_grams is None):
            raise ValueError("unit_name and unit_grams go together")
        return self


class FoodImport(CommandInput):
    """Add a product from Open Food Facts by barcode (or return it if already known)."""

    barcode: str = Field(pattern=r"^[0-9]{4,32}$")


class FoodSearch(QueryInput):
    """Search the local catalog and Open Food Facts."""

    q: str = Field(min_length=2, max_length=100)


class RemoteFood(BaseModel):
    """An Open Food Facts hit not yet in the catalog; import it with import_food."""

    barcode: str
    name: str
    brand: str | None
    per_100: Per100 | None
    usable: bool


class FoodSearchOut(BaseModel):
    """Local foods first, then remote hits; an outage leaves the local hits intact."""

    local: list[FoodOut]
    remote: list[RemoteFood]
    remote_error: str | None = None


class RecipeItemIn(StrictModel):
    """One ingredient."""

    food_id: uuid.UUID
    grams: float = Field(gt=0, le=5000)


class RecipeSave(CommandInput):
    """Create a recipe (without id) or add a new version of one (with id)."""

    id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    serves: int = Field(default=1, ge=1, le=50, description="Portions the items make.")
    steps: list[str] = Field(default_factory=list, max_length=50)
    items: list[RecipeItemIn] = Field(min_length=1, max_length=60)
    note: str | None = Field(default=None, max_length=2000)


class RecipeItemOut(BaseModel):
    """An ingredient with its current nutrients."""

    food_id: uuid.UUID
    name: str
    grams: float
    unit_name: str | None
    unit_grams: float | None
    nutrients: Nutrients


class RecipeOut(BaseModel):
    """A recipe's current version."""

    id: uuid.UUID
    name: str
    version_id: uuid.UUID
    serves: int
    steps: list[str]
    items: list[RecipeItemOut]
    totals: Nutrients
    per_portion: Nutrients
    note: str | None
    archived: bool
    versions: int


class RecipeListQuery(QueryInput):
    """List recipes."""

    include_archived: bool = False


class RecipeSummary(BaseModel):
    """A recipe in a list."""

    id: uuid.UUID
    name: str
    serves: int
    per_portion: Nutrients
    archived: bool


class RecipeList(BaseModel):
    """Recipes by name."""

    recipes: list[RecipeSummary]


class SnapshotItem(BaseModel):
    """An eaten amount of a food, with its nutrients frozen at that food version."""

    food_id: uuid.UUID
    food_version_id: uuid.UUID
    name: str
    kind: FoodKind
    grams: float
    nutrients: Nutrients
```

`backend/app/features/catalog/exceptions.py`:

```python
"""Every error the catalog feature raises."""

import uuid

from app.helpers.errors import Conflict, NotFound, ValidationFailed


class FoodNotFound(NotFound):
    def __init__(self, food_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"food {food_id} does not exist", field)


class RecipeNotFound(NotFound):
    def __init__(self, recipe_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"recipe {recipe_id} does not exist", field)


class FoodArchived(Conflict):
    def __init__(self, food_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"food {food_id} is archived", field)


class RecipeArchived(Conflict):
    def __init__(self, recipe_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"recipe {recipe_id} is archived", field)


class MissingForCreate(ValidationFailed):
    def __init__(self, field: str) -> None:
        super().__init__(f"{field} is required to create a food", field)


class NotOnOpenFoodFacts(NotFound):
    def __init__(self, barcode: str) -> None:
        super().__init__(f"Open Food Facts has no product {barcode}", "barcode")


class NoNutritionData(ValidationFailed):
    def __init__(self, name: str) -> None:
        super().__init__(f"{name} has no usable nutrition data on Open Food Facts", "barcode")
```

`backend/app/features/catalog/services.py`:

```python
"""Open Food Facts: product search and barcode lookup, normalised into OffProduct."""

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from app.features.catalog.models import Per100
from app.helpers.config import get_settings
from app.helpers.errors import Upstream
from app.helpers.services import services

_FIELDS = "code,product_name,product_name_de,product_name_en,brands,nutriments"
_KJ_PER_KCAL = 4.184


@dataclass(frozen=True)
class OffProduct:
    """A product as Open Food Facts describes it; per_100 is None when unusable."""

    barcode: str
    name: str
    brand: str | None
    per_100: Per100 | None


def _number(nutriments: dict[str, Any], key: str) -> float | None:
    try:
        return float(nutriments[key])
    except (KeyError, TypeError, ValueError):
        return None


def _brand(brands: Any) -> str | None:
    if isinstance(brands, list):
        return str(brands[0]) if brands else None
    if isinstance(brands, str) and brands.strip():
        return brands.split(",")[0].strip()
    return None


def parse_product(raw: dict[str, Any]) -> OffProduct:
    """Normalise a search hit or a product payload."""
    barcode = str(raw.get("code") or "")
    name = raw.get("product_name") or raw.get("product_name_de") or raw.get("product_name_en") or barcode
    nutriments = raw.get("nutriments") or {}
    kcal = _number(nutriments, "energy-kcal_100g")
    if kcal is None and (kilojoules := _number(nutriments, "energy_100g")) is not None:
        kcal = round(kilojoules / _KJ_PER_KCAL, 1)
    per_100 = None
    if kcal is not None:
        try:
            per_100 = Per100(
                kcal=kcal,
                protein_g=_number(nutriments, "proteins_100g"),
                carbs_g=_number(nutriments, "carbohydrates_100g"),
                fat_g=_number(nutriments, "fat_100g"),
                fiber_g=_number(nutriments, "fiber_100g"),
                sugar_g=_number(nutriments, "sugars_100g"),
                salt_g=_number(nutriments, "salt_100g"),
            )
        except ValidationError:
            per_100 = None
    return OffProduct(barcode=barcode, name=str(name), brand=_brand(raw.get("brands")), per_100=per_100)


class OpenFoodFactsClient:
    """Search and product lookup; every failure is an Upstream error."""

    def __init__(self, http: httpx.AsyncClient, search_url: str, product_url: str, user_agent: str) -> None:
        self._http = http
        self._search_url = search_url
        self._product_url = product_url
        self._headers = {"User-Agent": user_agent}

    async def _get(self, url: str, params: dict[str, Any]) -> httpx.Response:
        try:
            return await self._http.get(url, params=params, headers=self._headers, timeout=10)
        except httpx.HTTPError as exc:
            raise Upstream("Open Food Facts did not answer") from exc

    @staticmethod
    def _json(response: httpx.Response) -> Any:
        if response.is_error:
            raise Upstream(f"Open Food Facts answered {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Upstream("Open Food Facts answered with invalid JSON") from exc

    async def search(self, query: str, size: int = 20) -> list[OffProduct]:
        """Products matching a text query."""
        body = self._json(await self._get(self._search_url, {"q": query, "langs": "de,en", "page_size": size, "fields": _FIELDS}))
        hits = body.get("hits") if isinstance(body, dict) else None
        return [parse_product(hit) for hit in hits or [] if isinstance(hit, dict)]

    async def get_product(self, barcode: str) -> OffProduct | None:
        """One product by barcode, or None if Open Food Facts does not know it."""
        response = await self._get(f"{self._product_url}/{quote(barcode, safe='')}", {"fields": _FIELDS})
        if response.status_code == 404:
            return None
        body = self._json(response)
        product = body.get("product") if isinstance(body, dict) and body.get("status") == 1 else None
        return parse_product(product) if isinstance(product, dict) else None

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._http.aclose()


def _build() -> OpenFoodFactsClient:
    settings = get_settings()
    return OpenFoodFactsClient(httpx.AsyncClient(), settings.off_search_url, settings.off_product_url, settings.off_user_agent)


services.register("openfoodfacts", _build)


def openfoodfacts() -> OpenFoodFactsClient:
    """The Open Food Facts client in use."""
    return services.get("openfoodfacts")
```

- [ ] **Step 4: Implement the functions, routers and API**

`backend/app/features/catalog/functions.py`:

```python
"""Catalog logic: foods and recipes, their versions, search, and nutrient snapshots."""

import uuid
from collections.abc import Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.catalog.exceptions import (
    FoodArchived,
    FoodNotFound,
    MissingForCreate,
    NoNutritionData,
    NotOnOpenFoodFacts,
    RecipeArchived,
    RecipeNotFound,
)
from app.features.catalog.models import (
    Food,
    FoodImport,
    FoodOut,
    FoodSave,
    FoodSearch,
    FoodSearchOut,
    FoodVersion,
    Per100,
    Recipe,
    RecipeItemOut,
    RecipeList,
    RecipeListQuery,
    RecipeOut,
    RecipeSave,
    RecipeSummary,
    RecipeVersion,
    RemoteFood,
    SnapshotItem,
)
from app.features.catalog.services import openfoodfacts
from app.helpers.endpoints import Context
from app.helpers.errors import Upstream
from app.helpers.models import ById, ByIdCommand, Nutrients
from app.helpers.responses import Outcome

_NUTRIENT_COLUMNS = ("kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "salt_g")
_FOOD_COLUMNS = ("name", "brand", "kind", "unit_name", "unit_grams", "pack_grams")


def _per_100(version: FoodVersion) -> Per100:
    return Per100(**{name: getattr(version, name) for name in _NUTRIENT_COLUMNS})


async def _latest_food_versions(session: AsyncSession, food_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, FoodVersion]:
    rows = await session.scalars(
        select(FoodVersion)
        .distinct(FoodVersion.food_id)
        .where(FoodVersion.food_id.in_(food_ids))
        .order_by(FoodVersion.food_id, FoodVersion.valid_from.desc())
    )
    return {row.food_id: row for row in rows}


async def _version_counts(session: AsyncSession, column, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, int]:
    rows = await session.execute(select(column, func.count()).where(column.in_(ids)).group_by(column))
    return dict(rows.tuples().all())


async def _food_outs(session: AsyncSession, foods: Sequence[Food]) -> list[FoodOut]:
    ids = [food.id for food in foods]
    versions = await _latest_food_versions(session, ids)
    counts = await _version_counts(session, FoodVersion.food_id, ids)
    return [
        FoodOut(
            id=food.id,
            name=food.name,
            brand=food.brand,
            barcode=food.barcode,
            kind=food.kind,
            source=food.source,
            unit_name=food.unit_name,
            unit_grams=food.unit_grams,
            pack_grams=food.pack_grams,
            archived=food.archived_at is not None,
            version_id=versions[food.id].id,
            per_100=_per_100(versions[food.id]),
            versions=counts[food.id],
        )
        for food in foods
    ]


async def _food(session: AsyncSession, food_id: uuid.UUID, field: str = "id") -> Food:
    food = await session.get(Food, food_id)
    if food is None:
        raise FoodNotFound(food_id, field)
    return food


async def _foods_for_items(session: AsyncSession, food_ids: Sequence[uuid.UUID], field: str) -> dict[uuid.UUID, Food]:
    """Every referenced food, each existing and not archived; the field names the bad item."""
    rows = {food.id: food for food in await session.scalars(select(Food).where(Food.id.in_(food_ids)))}
    for index, food_id in enumerate(food_ids):
        item_field = f"{field}.{index}.food_id"
        if food_id not in rows:
            raise FoodNotFound(food_id, item_field)
        if rows[food_id].archived_at is not None:
            raise FoodArchived(food_id, item_field)
    return rows


def _add_version(ctx: Context, food: Food, per_100: Per100, note: str | None) -> None:
    ctx.session.add(FoodVersion(food_id=food.id, valid_from=ctx.now, source_note=note, **per_100.model_dump()))


async def import_food(ctx: Context, data: FoodImport) -> Outcome[FoodOut]:
    """Add a product from Open Food Facts, or return it when already in the catalog."""
    existing = await ctx.session.scalar(select(Food).where(Food.barcode == data.barcode))
    if existing is None:
        product = await openfoodfacts().get_product(data.barcode)
        if product is None:
            raise NotOnOpenFoodFacts(data.barcode)
        if product.per_100 is None:
            raise NoNutritionData(product.name)
        barcode = product.barcode or data.barcode
        existing = await ctx.session.scalar(select(Food).where(Food.barcode == barcode))
        if existing is None:
            existing = Food(name=product.name[:300], brand=product.brand, barcode=barcode, kind="food", source="off")
            ctx.session.add(existing)
            await ctx.session.flush()
            _add_version(ctx, existing, product.per_100, "Open Food Facts")
            await ctx.session.flush()
    return Outcome((await _food_outs(ctx.session, [existing]))[0])


async def save_food(ctx: Context, data: FoodSave) -> Outcome[FoodOut]:
    """Create a manual food, or change one; new nutrients add a version."""
    changes = data.model_dump(exclude_unset=True, include=set(_FOOD_COLUMNS))
    if data.id is None:
        if data.name is None:
            raise MissingForCreate("name")
        if data.per_100 is None:
            raise MissingForCreate("per_100")
        food = Food(source="manual", **({"kind": "food"} | changes))
        ctx.session.add(food)
        await ctx.session.flush()
        _add_version(ctx, food, data.per_100, None)
    else:
        food = await _food(ctx.session, data.id)
        if food.archived_at is not None:
            raise FoodArchived(food.id)
        for name, value in changes.items():
            setattr(food, name, value)
        current = (await _latest_food_versions(ctx.session, [food.id]))[food.id]
        if data.per_100 is not None and data.per_100 != _per_100(current):
            _add_version(ctx, food, data.per_100, None)
    await ctx.session.flush()
    return Outcome((await _food_outs(ctx.session, [food]))[0])


async def archive_food(ctx: Context, data: ByIdCommand) -> Outcome[FoodOut]:
    """Hide a food from search and new use; history keeps it."""
    food = await _food(ctx.session, data.id)
    if food.archived_at is None:
        food.archived_at = ctx.now
        await ctx.session.flush()
    return Outcome((await _food_outs(ctx.session, [food]))[0])


async def find_food(ctx: Context, data: FoodSearch) -> FoodSearchOut:
    """Local foods matching name or brand, then Open Food Facts hits not yet imported."""
    pattern = f"%{data.q}%"
    foods = (
        await ctx.session.scalars(
            select(Food)
            .where(Food.archived_at.is_(None), or_(Food.name.ilike(pattern), Food.brand.ilike(pattern)))
            .order_by(Food.name)
            .limit(20)
        )
    ).all()
    local = await _food_outs(ctx.session, foods)
    try:
        products = await openfoodfacts().search(data.q)
    except Upstream as exc:
        return FoodSearchOut(local=local, remote=[], remote_error=exc.message)
    codes = [p.barcode for p in products if p.barcode]
    known = set((await ctx.session.scalars(select(Food.barcode).where(Food.barcode.in_(codes)))).all())
    remote = [
        RemoteFood(barcode=p.barcode, name=p.name, brand=p.brand, per_100=p.per_100, usable=p.per_100 is not None)
        for p in products
        if p.barcode and p.barcode not in known
    ]
    return FoodSearchOut(local=local, remote=remote)


async def get_food(ctx: Context, data: ById) -> FoodOut:
    """One food with its current nutrients."""
    return (await _food_outs(ctx.session, [await _food(ctx.session, data.id)]))[0]


async def _recipe(session: AsyncSession, recipe_id: uuid.UUID, field: str = "id") -> Recipe:
    recipe = await session.get(Recipe, recipe_id)
    if recipe is None:
        raise RecipeNotFound(recipe_id, field)
    return recipe


async def _latest_recipe_versions(session: AsyncSession, recipe_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, RecipeVersion]:
    rows = await session.scalars(
        select(RecipeVersion)
        .distinct(RecipeVersion.recipe_id)
        .where(RecipeVersion.recipe_id.in_(recipe_ids))
        .order_by(RecipeVersion.recipe_id, RecipeVersion.valid_from.desc())
    )
    return {row.recipe_id: row for row in rows}


async def _recipe_items(session: AsyncSession, versions: Sequence[RecipeVersion]) -> dict[uuid.UUID, list[RecipeItemOut]]:
    food_ids = list({uuid.UUID(item["food_id"]) for version in versions for item in version.items})
    foods = {food.id: food for food in await session.scalars(select(Food).where(Food.id.in_(food_ids)))}
    food_versions = await _latest_food_versions(session, food_ids)
    result = {}
    for version in versions:
        items = []
        for item in version.items:
            food = foods[uuid.UUID(item["food_id"])]
            items.append(
                RecipeItemOut(
                    food_id=food.id,
                    name=food.name,
                    grams=item["grams"],
                    unit_name=food.unit_name,
                    unit_grams=food.unit_grams,
                    nutrients=_per_100(food_versions[food.id]).for_grams(item["grams"], food.kind),
                )
            )
        result[version.id] = items
    return result


async def _recipe_out(session: AsyncSession, recipe: Recipe) -> RecipeOut:
    version = (await _latest_recipe_versions(session, [recipe.id]))[recipe.id]
    items = (await _recipe_items(session, [version]))[version.id]
    totals = Nutrients.total(item.nutrients for item in items)
    counts = await _version_counts(session, RecipeVersion.recipe_id, [recipe.id])
    return RecipeOut(
        id=recipe.id,
        name=recipe.name,
        version_id=version.id,
        serves=version.serves,
        steps=version.steps,
        items=items,
        totals=totals,
        per_portion=totals.scaled(1 / version.serves),
        note=version.note,
        archived=recipe.archived_at is not None,
        versions=counts[recipe.id],
    )


async def save_recipe(ctx: Context, data: RecipeSave) -> Outcome[RecipeOut]:
    """Create a recipe or add a new version; every item's food must exist and be active."""
    await _foods_for_items(ctx.session, [item.food_id for item in data.items], "items")
    if data.id is None:
        recipe = Recipe(name=data.name)
        ctx.session.add(recipe)
        await ctx.session.flush()
    else:
        recipe = await _recipe(ctx.session, data.id)
        if recipe.archived_at is not None:
            raise RecipeArchived(recipe.id)
        recipe.name = data.name
    ctx.session.add(
        RecipeVersion(
            recipe_id=recipe.id,
            valid_from=ctx.now,
            serves=data.serves,
            steps=data.steps,
            items=[{"food_id": str(item.food_id), "grams": item.grams} for item in data.items],
            note=data.note,
        )
    )
    await ctx.session.flush()
    return Outcome(await _recipe_out(ctx.session, recipe))


async def archive_recipe(ctx: Context, data: ByIdCommand) -> Outcome[RecipeOut]:
    """Hide a recipe from lists and new use; history keeps it."""
    recipe = await _recipe(ctx.session, data.id)
    if recipe.archived_at is None:
        recipe.archived_at = ctx.now
        await ctx.session.flush()
    return Outcome(await _recipe_out(ctx.session, recipe))


async def get_recipe(ctx: Context, data: ById) -> RecipeOut:
    """One recipe's current version with totals and per-portion values."""
    return await _recipe_out(ctx.session, await _recipe(ctx.session, data.id))


async def list_recipes(ctx: Context, data: RecipeListQuery) -> RecipeList:
    """Recipes by name, each with its per-portion values."""
    statement = select(Recipe).order_by(Recipe.name)
    if not data.include_archived:
        statement = statement.where(Recipe.archived_at.is_(None))
    recipes = (await ctx.session.scalars(statement)).all()
    versions = await _latest_recipe_versions(ctx.session, [r.id for r in recipes])
    items = await _recipe_items(ctx.session, list(versions.values()))
    summaries = []
    for recipe in recipes:
        version = versions[recipe.id]
        totals = Nutrients.total(item.nutrients for item in items[version.id])
        summaries.append(
            RecipeSummary(
                id=recipe.id,
                name=recipe.name,
                serves=version.serves,
                per_portion=totals.scaled(1 / version.serves),
                archived=recipe.archived_at is not None,
            )
        )
    return RecipeList(recipes=summaries)


async def snapshot(session: AsyncSession, items: Sequence[tuple[uuid.UUID, float]], field: str = "items") -> list[SnapshotItem]:
    """Freeze the nutrients of eaten amounts at each food's current version (for the journal)."""
    food_ids = [uuid.UUID(str(food_id)) for food_id, _ in items]
    foods = await _foods_for_items(session, food_ids, field)
    versions = await _latest_food_versions(session, food_ids)
    return [
        SnapshotItem(
            food_id=food_id,
            food_version_id=versions[food_id].id,
            name=foods[food_id].name,
            kind=foods[food_id].kind,
            grams=grams,
            nutrients=_per_100(versions[food_id]).for_grams(grams, foods[food_id].kind),
        )
        for food_id, (_, grams) in zip(food_ids, items, strict=True)
    ]


async def recipe_items(
    session: AsyncSession, recipe_id: uuid.UUID, portions: float, field: str = "recipe_id"
) -> tuple[uuid.UUID, list[tuple[uuid.UUID, float]]]:
    """The current version id and its items scaled to `portions` (for the journal)."""
    recipe = await _recipe(session, uuid.UUID(str(recipe_id)), field)
    if recipe.archived_at is not None:
        raise RecipeArchived(recipe.id, field)
    version = (await _latest_recipe_versions(session, [recipe.id]))[recipe.id]
    factor = portions / version.serves
    return version.id, [(uuid.UUID(item["food_id"]), round(item["grams"] * factor, 2)) for item in version.items]
```

`backend/app/features/catalog/routers.py`:

```python
"""The catalog feature's endpoints."""

from app.features.catalog import functions
from app.features.catalog.exceptions import (
    FoodArchived,
    FoodNotFound,
    MissingForCreate,
    NoNutritionData,
    NotOnOpenFoodFacts,
    RecipeArchived,
    RecipeNotFound,
)
from app.features.catalog.models import (
    FoodImport,
    FoodOut,
    FoodSave,
    FoodSearch,
    FoodSearchOut,
    RecipeList,
    RecipeListQuery,
    RecipeOut,
    RecipeSave,
)
from app.helpers.endpoints import command, query
from app.helpers.models import ById, ByIdCommand

OPERATIONS = (
    command("import_food", FoodImport, FoodOut, functions.import_food,
            "Add an Open Food Facts product to the catalog by barcode (from a find_food remote hit); "
            "returns the existing food if it is already there.",
            errors=(NotOnOpenFoodFacts, NoNutritionData)),
    command("save_food", FoodSave, FoodOut, functions.save_food,
            "Create a food by hand (without id; name and per_100 required) or change one (with id; only "
            "sent fields change). New nutrients add a version; past intakes keep theirs.",
            errors=(FoodNotFound, FoodArchived, MissingForCreate)),
    command("archive_food", ByIdCommand, FoodOut, functions.archive_food,
            "Hide a food from search and new use; history keeps it.",
            errors=(FoodNotFound,), destructive=True),
    command("save_recipe", RecipeSave, RecipeOut, functions.save_recipe,
            "Create a recipe (without id) or add a new version (with id): items, serves and steps.",
            errors=(RecipeNotFound, RecipeArchived, FoodNotFound, FoodArchived)),
    command("archive_recipe", ByIdCommand, RecipeOut, functions.archive_recipe,
            "Hide a recipe from lists and new use; history keeps it.",
            errors=(RecipeNotFound,), destructive=True),
    query("find_food", FoodSearch, FoodSearchOut, functions.find_food,
          "Search foods: local catalog first, then Open Food Facts hits to import with import_food.",
          view="catalog"),
    query("get_food", ById, FoodOut, functions.get_food,
          "One food with its current nutrients per 100 g/ml.", errors=(FoodNotFound,), view="food"),
    query("get_recipe", ById, RecipeOut, functions.get_recipe,
          "One recipe: items, steps, totals and per portion.", errors=(RecipeNotFound,), view="recipe"),
    query("list_recipes", RecipeListQuery, RecipeList, functions.list_recipes,
          "All recipes by name with per-portion nutrients.", view="recipes"),
)
```

Run `uv run ruff format` after creating this file; the formatter will reflow the argument
lists.

`backend/app/features/catalog/catalog.py`:

```python
"""The catalog feature's API."""

from app.features.catalog.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(name="catalog", operations=OPERATIONS)
```

In `backend/app/main.py`, add `from app.features.catalog.catalog import api as catalog` and set:

```python
FEATURES: tuple[FeatureApi, ...] = (profile, catalog)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (catalog: `3` + `8` + `5` = `16 passed`)

- [ ] **Step 6: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(catalog): versioned foods and recipes, Open Food Facts import and search

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 10: Journal payloads, kind registry and drafts

**Files:**
- Create: `backend/app/features/journal/__init__.py` (empty), `backend/app/features/journal/payloads.py`
- Test: `backend/tests/features/journal/__init__.py` (empty), `backend/tests/features/journal/test_payloads.py`

**Interfaces:**
- Consumes: `Nutrients`, `StrictModel`, `UtcDatetime` (Task 2).
- Produces:
  - `Slot`, `Relation`, `SymptomType`, `Metric`, `METRICS: dict[str, str]` (metric → unit)
  - Payload models `IntakeIn`, `IntakeItemIn`, `IntakeStored`, `IntakeItemStored`,
    `OuttakeP`, `SymptomP`, `DoseP`, `SleepStages`, `SleepP`, `ActivityP`, `WorkoutSet`,
    `WorkoutExercise`, `WorkoutP`, `MeasurementP`, `CheckinP` and `NoteP`
  - `KindSpec(kind, input, stored, ends: "forbidden"|"optional"|"required", version=1, upcasters={})`
  - `KINDS: dict[str, KindSpec]`, `Kind` (Literal of every kind)
  - `upcast(spec, version, payload) -> dict`, `current_payload(kind, version, payload) -> dict`
  - `LinkIn(to_chain, relation)`, `DRAFTS` (one model per kind), and `EventDraft` (a
    discriminated union on `kind`)

- [ ] **Step 1: Write the failing tests**

`backend/tests/features/journal/test_payloads.py`:

```python
import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from app.features.journal.payloads import (
    KINDS,
    EventDraft,
    IntakeIn,
    KindSpec,
    MeasurementP,
    NoteP,
    upcast,
)

DRAFTS = TypeAdapter(EventDraft)
AT = "2026-09-30T08:00:00+02:00"
EXAMPLES = {
    "intake": {"items": [{"food_id": "00000000-0000-0000-0000-000000000001", "grams": 150}], "slot": "breakfast"},
    "outtake": {"bristol": 4},
    "symptom": {"type": "bloated", "severity": 2},
    "medication": {"name": "Ibuprofen", "dose": 400, "unit": "mg", "reason": "headache"},
    "supplement": {"name": "Vitamin D", "dose": 1000, "unit": "IE"},
    "sleep": {"quality": 4, "stages": {"deep_min": 80, "light_min": 240, "rem_min": 90, "awake_min": 20}},
    "activity": {"steps": 8421},
    "workout": {"title": "Push", "category": "strength", "exercises": [{"name": "Bench", "category": "strength", "sets": [{"reps": 8, "weight_kg": 80}]}]},
    "measurement": {"metric": "weight_kg", "value": 84.3},
    "checkin": {"overall": 3, "mood": 4},
    "note": {"text": "slept badly"},
}


def test_every_kind_has_an_example_that_validates():
    assert set(EXAMPLES) == set(KINDS)
    for kind, payload in EXAMPLES.items():
        draft = DRAFTS.validate_python({"kind": kind, "occurred_at": AT, "payload": payload})
        assert draft.kind == kind


def test_intake_needs_items_or_a_recipe_but_not_both():
    with pytest.raises(ValidationError, match="either items or recipe_id"):
        IntakeIn()
    with pytest.raises(ValidationError, match="either items or recipe_id"):
        IntakeIn(items=[{"food_id": "00000000-0000-0000-0000-000000000001", "grams": 1}], recipe_id="00000000-0000-0000-0000-000000000002")
    with pytest.raises(ValidationError, match="portions need a recipe_id"):
        IntakeIn(items=[{"food_id": "00000000-0000-0000-0000-000000000001", "grams": 1}], portions=2)
    assert IntakeIn(recipe_id="00000000-0000-0000-0000-000000000002", portions=1.5).portions == 1.5


def test_measurement_unit_is_filled_and_checked():
    assert MeasurementP(metric="weight_kg", value=84).unit == "kg"
    with pytest.raises(ValidationError):
        MeasurementP(metric="weight_kg", value=84, unit="lb")
    with pytest.raises(ValidationError):
        MeasurementP(metric="iq", value=84)


def test_activity_needs_at_least_one_value():
    with pytest.raises(ValidationError):
        DRAFTS.validate_python({"kind": "activity", "occurred_at": AT, "payload": {}})


def test_drafts_reject_naive_times_and_unknown_fields():
    with pytest.raises(ValidationError):
        DRAFTS.validate_python({"kind": "note", "occurred_at": "2026-09-30T08:00:00", "payload": {"text": "x"}})
    with pytest.raises(ValidationError):
        DRAFTS.validate_python({"kind": "note", "occurred_at": AT, "payload": {"text": "x", "mood": 1}})


def test_the_draft_schema_is_discriminated_by_kind():
    class Wrapper(BaseModel):
        event: EventDraft

    schema = Wrapper.model_json_schema()
    mapping = schema["properties"]["event"]["discriminator"]["mapping"]
    assert set(mapping) == set(KINDS)


def test_upcast_applies_each_step_in_order():
    spec = KindSpec(
        "note",
        NoteP,
        NoteP,
        ends="forbidden",
        version=3,
        upcasters={1: lambda p: {"text": p["body"]}, 2: lambda p: {"text": p["text"].strip()}},
    )
    assert upcast(spec, 1, {"body": " hi "}) == {"text": "hi"}
    assert upcast(spec, 3, {"text": "done"}) == {"text": "done"}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/journal/test_payloads.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.features.journal'`

- [ ] **Step 3: Implement**

`backend/app/features/journal/payloads.py`:

```python
"""Every event kind: what callers send, what is stored, and how old payloads are upgraded."""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import reduce
from operator import or_
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, create_model, model_validator

from app.helpers.models import Nutrients, StrictModel, UtcDatetime

Slot = Literal["breakfast", "lunch", "dinner", "snack"]
Relation = Literal["suspected_cause", "part_of", "follows"]
SymptomType = Literal[
    "stomach_ache", "gas", "bloated", "nausea", "diarrhea", "constipation", "heartburn", "headache", "fatigue", "skin", "other"
]
METRICS: dict[str, str] = {
    "weight_kg": "kg",
    "waist_cm": "cm",
    "body_fat_pct": "%",
    "resting_hr_bpm": "bpm",
    "hrv_ms": "ms",
    "spo2_pct": "%",
    "skin_temp_delta_c": "°C",
    "blood_pressure_sys": "mmHg",
    "blood_pressure_dia": "mmHg",
}
Metric = Literal[tuple(METRICS)]
Note = Annotated[str | None, Field(max_length=2000)]


class IntakeItemIn(StrictModel):
    """An eaten amount of a catalog food."""

    food_id: uuid.UUID
    grams: float = Field(gt=0, le=5000, description="Grams, or ml for drinks.")


class IntakeIn(StrictModel):
    """What was eaten or drunk: either items, or a recipe with portions."""

    slot: Slot | None = None
    items: list[IntakeItemIn] = Field(default_factory=list, max_length=60)
    recipe_id: uuid.UUID | None = None
    portions: float | None = Field(default=None, gt=0, le=20, description="Portions of the recipe; default 1.")
    note: Note = None

    @model_validator(mode="after")
    def _items_or_recipe(self) -> "IntakeIn":
        if bool(self.items) == (self.recipe_id is not None):
            raise ValueError("send either items or recipe_id")
        if self.portions is not None and self.recipe_id is None:
            raise ValueError("portions need a recipe_id")
        return self


class IntakeItemStored(BaseModel):
    """An eaten amount with its nutrients frozen at the food version."""

    food_id: uuid.UUID
    food_version_id: uuid.UUID
    name: str
    grams: float
    nutrients: Nutrients


class IntakeStored(BaseModel):
    """An intake as stored: resolved items, their snapshot, and the total."""

    slot: Slot | None
    items: list[IntakeItemStored]
    recipe_id: uuid.UUID | None
    recipe_version_id: uuid.UUID | None
    portions: float | None
    note: str | None
    nutrients: Nutrients


class OuttakeP(StrictModel):
    """A bowel movement."""

    bristol: int = Field(ge=1, le=7, description="Bristol stool scale 1-7.")
    urgency: bool | None = None
    pain: int | None = Field(default=None, ge=0, le=5)
    flags: list[Literal["blood", "mucus", "undigested"]] = Field(default_factory=list, max_length=3)
    note: Note = None


class SymptomP(StrictModel):
    """Something felt; link it to suspected causes with links."""

    type: SymptomType
    severity: int = Field(ge=1, le=5)
    body_area: str | None = Field(default=None, max_length=100)
    note: Note = None


class DoseP(StrictModel):
    """A dose of a medication or supplement."""

    name: str = Field(min_length=1, max_length=200)
    dose: float = Field(gt=0, le=100000)
    unit: str = Field(min_length=1, max_length=20)
    reason: str | None = Field(default=None, max_length=500)
    note: Note = None


class SleepStages(StrictModel):
    """Minutes per sleep stage."""

    deep_min: int = Field(ge=0, le=1440)
    light_min: int = Field(ge=0, le=1440)
    rem_min: int = Field(ge=0, le=1440)
    awake_min: int = Field(ge=0, le=1440)


class SleepP(StrictModel):
    """A sleep period; occurred_at is falling asleep, ends_at waking up."""

    quality: int | None = Field(default=None, ge=1, le=5)
    stages: SleepStages | None = None
    efficiency_pct: float | None = Field(default=None, ge=0, le=100)
    note: Note = None


class ActivityP(StrictModel):
    """A day's movement totals; occurred_at/ends_at span the local day."""

    steps: int | None = Field(default=None, ge=0, le=200000)
    active_minutes: int | None = Field(default=None, ge=0, le=1440)
    distance_km: float | None = Field(default=None, ge=0, le=500)

    @model_validator(mode="after")
    def _something(self) -> "ActivityP":
        if self.steps is None and self.active_minutes is None and self.distance_km is None:
            raise ValueError("send steps, active_minutes or distance_km")
        return self


class WorkoutSet(StrictModel):
    """One completed set."""

    reps: int | None = Field(default=None, ge=0, le=1000)
    weight_kg: float | None = Field(default=None, ge=0, le=1000)
    duration_s: int | None = Field(default=None, ge=0, le=86400)
    rpe: float | None = Field(default=None, ge=0, le=10)


class WorkoutExercise(StrictModel):
    """One exercise with its completed sets."""

    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=50)
    sets: list[WorkoutSet] = Field(default_factory=list, max_length=100)


class WorkoutP(StrictModel):
    """A training session."""

    title: str = Field(min_length=1, max_length=200)
    category: Literal["strength", "cardio", "mixed", "other"]
    set_count: int | None = Field(default=None, ge=0)
    volume_kg: float | None = Field(default=None, ge=0)
    exercises: list[WorkoutExercise] = Field(default_factory=list, max_length=50)
    note: Note = None


class MeasurementP(StrictModel):
    """One body value; the unit is fixed per metric."""

    metric: Metric
    value: float = Field(ge=-1000, le=100000)
    unit: str | None = None

    @model_validator(mode="after")
    def _unit(self) -> "MeasurementP":
        expected = METRICS[self.metric]
        if self.unit not in (None, expected):
            raise ValueError(f"{self.metric} is measured in {expected}")
        self.unit = expected
        return self


class CheckinP(StrictModel):
    """How the day feels, 1 (bad) to 5 (good)."""

    overall: int = Field(ge=1, le=5)
    energy: int | None = Field(default=None, ge=1, le=5)
    mood: int | None = Field(default=None, ge=1, le=5)
    stress: int | None = Field(default=None, ge=1, le=5)
    note: Note = None


class NoteP(StrictModel):
    """Free text."""

    text: str = Field(min_length=1, max_length=5000)


Upcaster = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class KindSpec:
    """One event kind: its input and stored models, time rule and payload upgrades."""

    kind: str
    input: type[BaseModel]
    stored: type[BaseModel]
    ends: Literal["forbidden", "optional", "required"] = "optional"
    version: int = 1
    upcasters: dict[int, Upcaster] = field(default_factory=dict)


KINDS: dict[str, KindSpec] = {
    spec.kind: spec
    for spec in (
        KindSpec("intake", IntakeIn, IntakeStored, ends="forbidden"),
        KindSpec("outtake", OuttakeP, OuttakeP, ends="forbidden"),
        KindSpec("symptom", SymptomP, SymptomP),
        KindSpec("medication", DoseP, DoseP, ends="forbidden"),
        KindSpec("supplement", DoseP, DoseP, ends="forbidden"),
        KindSpec("sleep", SleepP, SleepP, ends="required"),
        KindSpec("activity", ActivityP, ActivityP, ends="required"),
        KindSpec("workout", WorkoutP, WorkoutP),
        KindSpec("measurement", MeasurementP, MeasurementP, ends="forbidden"),
        KindSpec("checkin", CheckinP, CheckinP, ends="forbidden"),
        KindSpec("note", NoteP, NoteP, ends="forbidden"),
    )
}
Kind = Literal[tuple(KINDS)]


def upcast(spec: KindSpec, version: int, payload: dict[str, Any]) -> dict[str, Any]:
    """Lift a stored payload from `version` to the kind's current version, step by step."""
    while version < spec.version:
        payload = spec.upcasters[version](payload)
        version += 1
    return payload


def current_payload(kind: str, version: int, payload: dict[str, Any]) -> dict[str, Any]:
    """A stored payload in its kind's current shape."""
    return upcast(KINDS[kind], version, payload)


class LinkIn(StrictModel):
    """Link the new event to an existing chain, e.g. a symptom to a suspected meal."""

    to_chain: uuid.UUID
    relation: Relation


def _draft(spec: KindSpec) -> type[BaseModel]:
    return create_model(
        f"{spec.kind.capitalize()}Draft",
        __base__=StrictModel,
        kind=(Literal[spec.kind], ...),
        occurred_at=(UtcDatetime, ...),
        ends_at=(UtcDatetime | None, None),
        payload=(spec.input, ...),
        links=(list[LinkIn], Field(default_factory=list, max_length=10)),
    )


DRAFTS: tuple[type[BaseModel], ...] = tuple(_draft(spec) for spec in KINDS.values())
EventDraft = Annotated[reduce(or_, DRAFTS), Field(discriminator="kind")]
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/features/journal/test_payloads.py -q`
Expected: `7 passed`

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(journal): event kinds, payload models, upcasting and discriminated drafts

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Writing to the journal

**Files:**
- Create: `backend/app/features/journal/models.py`, `backend/app/features/journal/exceptions.py`, `backend/app/features/journal/functions.py`, `backend/app/features/journal/routers.py`, `backend/app/features/journal/journal.py`
- Modify: `backend/app/main.py` (add the API to `FEATURES`)
- Test: `backend/tests/features/journal/helpers.py`, `backend/tests/features/journal/test_writing.py`

**Interfaces:**
- Consumes: payloads (Task 10); `timezone_at` (Task 8); `snapshot` and `recipe_items`
  (Task 9); helpers.
- Produces:
  - Tables `Event` (`event`) and `EventLink` (`event_link`)
  - Models `LinkOut(chain_id, relation, direction: "outgoing"|"incoming")`,
    `EventOut(id, chain_id, version, kind, occurred_at, ends_at, local_day, payload, source, recorded_at, retracted, links)`,
    `LogEvents(events)`, `EventsOut(events)`, `CorrectEvent(id, occurred_at?, ends_at?, payload?)`,
    `RetractEvent(id, reason?)`, `LinkEvents(from_chain, to_chain, relation)`,
    `LinkResult`, `QueryEvents(from_day, to_day, kinds?, include_retracted=False)`,
    `ChainQuery(chain_id)`, `EventHistory(chain_id, kind, versions, links)`,
    `ExternalDraft(external_id, content_hash, kind, occurred_at, ends_at?, payload)`
  - Exceptions `EventNotFound`, `StaleHead` (code `stale_head`), `EventRetracted`,
    `EndRequired`, `EndForbidden`, `EndBeforeStart`, `SelfLink`, `LinkNotFound` and
    `InvalidRange`
  - Commands `log_events`, `correct_event`, `retract_event`, `link_events` and `unlink_events`
  - Internal helpers used by Task 12: `_insert`, `_stored_payload`, `_validate`,
    `_check_times`, `_outs`, `_links`

- [ ] **Step 1: Write the helpers and the failing tests**

`backend/tests/features/journal/helpers.py`:

```python
"""Small builders for journal tests."""

from typing import Any

import httpx

AT = "2026-09-30T08:00:00+02:00"


async def food(rest: httpx.AsyncClient, name: str = "Skyr", kcal: float = 62, protein: float = 11, kind: str = "food") -> dict[str, Any]:
    body = {"name": name, "kind": kind, "per_100": {"kcal": kcal, "protein_g": protein}}
    return (await rest.post("/api/v2/commands/save_food", json=body)).json()["result"]


def draft(kind: str, payload: dict[str, Any], occurred_at: str = AT, **extra: Any) -> dict[str, Any]:
    return {"kind": kind, "occurred_at": occurred_at, "payload": payload, **extra}


async def log(rest: httpx.AsyncClient, *drafts: dict[str, Any], **extra: Any) -> httpx.Response:
    return await rest.post("/api/v2/commands/log_events", json={"events": list(drafts), **extra})


async def logged(rest: httpx.AsyncClient, *drafts: dict[str, Any]) -> list[dict[str, Any]]:
    response = await log(rest, *drafts)
    assert response.status_code == 200, response.json()
    return response.json()["result"]["events"]
```

`backend/tests/features/journal/test_writing.py`:

```python
from tests.clients import call_tool
from tests.conftest import requires_db
from tests.features.journal.helpers import draft, food, log, logged

pytestmark = requires_db


async def test_intake_snapshots_nutrients_and_uses_the_local_day(rest):
    skyr = await food(rest)
    [event] = await logged(rest, draft("intake", {"items": [{"food_id": skyr["id"], "grams": 250}]}, occurred_at="2026-09-30T22:30:00Z"))
    assert event["local_day"] == "2026-10-01"
    assert (event["version"], event["source"], event["retracted"]) == (1, "app", False)
    assert event["payload"]["nutrients"]["kcal"] == 155
    assert event["payload"]["items"][0]["name"] == "Skyr"


async def test_intake_from_a_recipe_scales_to_portions(rest):
    skyr = await food(rest)
    recipe = (await rest.post("/api/v2/commands/save_recipe", json={"name": "Bowl", "serves": 2, "items": [{"food_id": skyr["id"], "grams": 400}]})).json()["result"]
    [event] = await logged(rest, draft("intake", {"recipe_id": recipe["id"], "portions": 1}))
    assert event["payload"]["items"][0]["grams"] == 200
    assert event["payload"]["recipe_version_id"] == recipe["version_id"]


async def test_drinks_count_as_fluid(rest):
    water = await food(rest, "Wasser", 0, 0, kind="drink")
    [event] = await logged(rest, draft("intake", {"items": [{"food_id": water["id"], "grams": 500}]}))
    assert event["payload"]["nutrients"]["fluid_ml"] == 500


async def test_time_rules_per_kind(rest):
    no_end = await log(rest, draft("sleep", {"quality": 3}))
    assert (no_end.status_code, no_end.json()["field"]) == (422, "events.0.ends_at")
    reversed_ = await log(rest, draft("sleep", {}, occurred_at="2026-09-30T07:00:00Z", ends_at="2026-09-29T23:00:00Z"))
    assert (reversed_.status_code, reversed_.json()["field"]) == (422, "events.0.ends_at")
    forbidden = await log(rest, draft("measurement", {"metric": "weight_kg", "value": 84}, ends_at="2026-09-30T09:00:00Z"))
    assert (forbidden.status_code, forbidden.json()["field"]) == (422, "events.0.ends_at")


async def test_payload_and_reference_errors_name_the_field(rest):
    bad = await log(rest, draft("symptom", {"type": "bloated", "severity": 9}))
    assert bad.status_code == 422
    assert bad.json()["field"].startswith("events.0") and bad.json()["field"].endswith("severity")
    unknown_food = await log(rest, draft("intake", {"items": [{"food_id": "00000000-0000-0000-0000-000000000009", "grams": 1}]}))
    assert (unknown_food.status_code, unknown_food.json()["field"]) == (404, "events.0.payload.items.0.food_id")
    unknown_link = await log(rest, draft("note", {"text": "x"}, links=[{"to_chain": "00000000-0000-0000-0000-000000000009", "relation": "follows"}]))
    assert (unknown_link.status_code, unknown_link.json()["field"]) == (404, "events.0.links.0.to_chain")


async def test_a_symptom_links_to_its_suspected_meal(rest):
    skyr = await food(rest)
    [meal] = await logged(rest, draft("intake", {"items": [{"food_id": skyr["id"], "grams": 100}]}))
    [symptom] = await logged(rest, draft("symptom", {"type": "bloated", "severity": 3}, links=[{"to_chain": meal["chain_id"], "relation": "suspected_cause"}]))
    assert symptom["links"] == [{"chain_id": meal["chain_id"], "relation": "suspected_cause", "direction": "outgoing"}]
    history = (await rest.get("/api/v2/views/event", params={"chain_id": meal["chain_id"]})).json()
    assert history["links"] == [{"chain_id": symptom["chain_id"], "relation": "suspected_cause", "direction": "incoming"}]


async def test_correcting_adds_a_version_and_old_ids_become_stale(rest):
    [note] = await logged(rest, draft("note", {"text": "first"}))
    fixed = (await rest.post("/api/v2/commands/correct_event", json={"id": note["id"], "payload": {"text": "second"}})).json()["result"]
    assert (fixed["chain_id"], fixed["version"], fixed["payload"]["text"]) == (note["chain_id"], 2, "second")
    stale = await rest.post("/api/v2/commands/correct_event", json={"id": note["id"], "payload": {"text": "third"}})
    assert (stale.status_code, stale.json()["code"]) == (409, "stale_head")
    history = (await rest.get("/api/v2/views/event", params={"chain_id": note["chain_id"]})).json()
    assert [v["payload"]["text"] for v in history["versions"]] == ["first", "second"]


async def test_correcting_times_and_links_survive(rest):
    [meal] = await logged(rest, draft("note", {"text": "meal"}))
    [symptom] = await logged(rest, draft("symptom", {"type": "gas", "severity": 2}, links=[{"to_chain": meal["chain_id"], "relation": "suspected_cause"}]))
    moved = (await rest.post("/api/v2/commands/correct_event", json={"id": symptom["id"], "occurred_at": "2026-10-01T09:00:00Z"})).json()
    assert moved["result"]["local_day"] == "2026-10-01"
    assert sorted(moved["effects"]["days"]) == ["2026-09-30", "2026-10-01"]
    assert moved["result"]["links"][0]["chain_id"] == meal["chain_id"]
    empty = await rest.post("/api/v2/commands/correct_event", json={"id": moved["result"]["id"]})
    assert empty.status_code == 422


async def test_retracting_is_idempotent_and_blocks_corrections(rest):
    [note] = await logged(rest, draft("note", {"text": "oops"}))
    first = (await rest.post("/api/v2/commands/retract_event", json={"id": note["id"], "reason": "duplicate"})).json()["result"]
    again = (await rest.post("/api/v2/commands/retract_event", json={"id": note["id"]})).json()["result"]
    assert first["retracted"] and again["retracted"]
    blocked = await rest.post("/api/v2/commands/correct_event", json={"id": note["id"], "payload": {"text": "x"}})
    assert (blocked.status_code, blocked.json()["code"]) == (409, "conflict")
    missing = await rest.post("/api/v2/commands/retract_event", json={"id": "00000000-0000-0000-0000-000000000009"})
    assert missing.status_code == 404


async def test_link_and_unlink(rest):
    [a, b] = await logged(rest, draft("note", {"text": "a"}), draft("note", {"text": "b"}))
    body = {"from_chain": a["chain_id"], "to_chain": b["chain_id"], "relation": "follows"}
    assert (await rest.post("/api/v2/commands/link_events", json=body)).status_code == 200
    assert (await rest.post("/api/v2/commands/link_events", json=body)).status_code == 200
    self_link = await rest.post("/api/v2/commands/link_events", json=body | {"to_chain": a["chain_id"]})
    assert (self_link.status_code, self_link.json()["field"]) == (422, "to_chain")
    assert (await rest.post("/api/v2/commands/unlink_events", json=body)).status_code == 200
    gone = await rest.post("/api/v2/commands/unlink_events", json=body)
    assert (gone.status_code, gone.json()["code"]) == (404, "not_found")


async def test_idempotency_key_logs_once(rest):
    first = await log(rest, draft("note", {"text": "once"}), idempotency_key="log-1")
    second = await log(rest, draft("note", {"text": "once"}), idempotency_key="log-1")
    assert first.json() == second.json()


async def test_timezone_follows_the_profile(rest):
    await rest.post("/api/v2/commands/update_profile", json={"timezone": "Asia/Tokyo"})
    [event] = await logged(rest, draft("note", {"text": "x"}, occurred_at="2099-01-01T16:00:00Z"))
    assert event["local_day"] == "2099-01-02"


async def test_claude_logs_through_mcp(mcp):
    async with mcp() as client:
        body = await call_tool(client, "log_events", {"events": [draft("checkin", {"overall": 4})]})
    assert body["result"]["events"][0]["source"] == "claude"
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/journal/test_writing.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.features.journal.models'`

- [ ] **Step 3: Implement the models and exceptions**

`backend/app/features/journal/models.py`:

```python
"""Journal tables and the journal's own input/output models."""

import uuid
from datetime import date, datetime
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Mapped, mapped_column

from app.features.journal.payloads import EventDraft, Kind, Relation
from app.helpers.database import Base
from app.helpers.models import CommandInput, QueryInput, UtcDatetime


class Event(Base):
    """One version of a fact. A chain is all versions of one fact; exactly one is its head."""

    __tablename__ = "event"
    __table_args__ = (
        sa.Index("uq_event_chain_head", "chain_id", unique=True, postgresql_where=sa.text("is_head")),
        sa.Index(
            "uq_event_external_head",
            "external_source",
            "external_id",
            unique=True,
            postgresql_where=sa.text("is_head AND external_id IS NOT NULL"),
        ),
        sa.Index("ix_event_day_kind", "local_day", "kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    chain_id: Mapped[uuid.UUID] = mapped_column(index=True)
    supersedes: Mapped[uuid.UUID | None] = mapped_column(sa.ForeignKey("event.id"))
    version: Mapped[int]
    is_head: Mapped[bool] = mapped_column(default=True)
    kind: Mapped[str] = mapped_column(sa.String(32))
    schema_version: Mapped[int]
    occurred_at: Mapped[datetime]
    ends_at: Mapped[datetime | None]
    local_day: Mapped[date]
    payload: Mapped[dict[str, Any]]
    source: Mapped[str] = mapped_column(sa.String(32))
    external_source: Mapped[str | None] = mapped_column(sa.String(64))
    external_id: Mapped[str | None] = mapped_column(sa.String(200))
    content_hash: Mapped[str | None] = mapped_column(sa.String(64))
    recorded_at: Mapped[datetime]
    retracted_at: Mapped[datetime | None]
    retract_reason: Mapped[str | None] = mapped_column(sa.String(500))


class EventLink(Base):
    """A relation between two chains, e.g. symptom → suspected_cause → intake."""

    __tablename__ = "event_link"

    from_chain: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    to_chain: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    relation: Mapped[str] = mapped_column(sa.String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(server_default=sa.func.now())


class LinkOut(BaseModel):
    """A link seen from one chain."""

    chain_id: uuid.UUID
    relation: Relation
    direction: Literal["outgoing", "incoming"]


class EventOut(BaseModel):
    """One event version; the payload is always in its kind's current shape."""

    id: uuid.UUID
    chain_id: uuid.UUID
    version: int
    kind: Kind
    occurred_at: datetime
    ends_at: datetime | None
    local_day: date
    payload: dict[str, Any]
    source: str
    recorded_at: datetime
    retracted: bool
    links: list[LinkOut] = Field(default_factory=list)


class LogEvents(CommandInput):
    """Log 1-50 facts; each needs kind, occurred_at (with offset) and payload."""

    events: list[EventDraft] = Field(min_length=1, max_length=50)


class EventsOut(BaseModel):
    """Events in time order."""

    events: list[EventOut]


class CorrectEvent(CommandInput):
    """Replace times and/or payload of the current version; the payload is sent whole."""

    id: uuid.UUID = Field(description="The current version's id (the head).")
    occurred_at: UtcDatetime | None = None
    ends_at: UtcDatetime | None = None
    payload: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _something(self) -> "CorrectEvent":
        if not {"occurred_at", "ends_at", "payload"} & self.model_fields_set:
            raise ValueError("send occurred_at, ends_at or payload")
        return self


class RetractEvent(CommandInput):
    """Stop a chain from counting; history keeps it."""

    id: uuid.UUID = Field(description="The current version's id (the head).")
    reason: str | None = Field(default=None, max_length=500)


class LinkEvents(CommandInput):
    """Relate two chains."""

    from_chain: uuid.UUID
    to_chain: uuid.UUID
    relation: Relation


class LinkResult(BaseModel):
    """A stored link."""

    from_chain: uuid.UUID
    to_chain: uuid.UUID
    relation: Relation


class QueryEvents(QueryInput):
    """Current versions between two local days (at most 366 days)."""

    from_day: date
    to_day: date
    kinds: list[Kind] | None = None
    include_retracted: bool = False


class ChainQuery(QueryInput):
    """One chain."""

    chain_id: uuid.UUID


class EventHistory(BaseModel):
    """Every version of a chain, oldest first, with its links."""

    chain_id: uuid.UUID
    kind: Kind
    versions: list[EventOut]
    links: list[LinkOut]


class ExternalDraft(BaseModel):
    """A fact from an external source, identified by the source's own id."""

    external_id: str = Field(min_length=1, max_length=200)
    content_hash: str = Field(min_length=1, max_length=64)
    kind: Kind
    occurred_at: UtcDatetime
    ends_at: UtcDatetime | None = None
    payload: dict[str, Any]
```

`backend/app/features/journal/exceptions.py`:

```python
"""Every error the journal feature raises."""

import uuid

from app.helpers.errors import Conflict, NotFound, ValidationFailed


def _at(prefix: str, name: str) -> str:
    return f"{prefix}.{name}" if prefix else name


class EventNotFound(NotFound):
    def __init__(self, event_id: uuid.UUID, field: str = "id") -> None:
        super().__init__(f"event {event_id} does not exist", field)


class StaleHead(Conflict):
    code = "stale_head"

    def __init__(self, event_id: uuid.UUID, head_id: uuid.UUID) -> None:
        super().__init__(f"event {event_id} was already corrected; the current version is {head_id}", "id")


class EventRetracted(Conflict):
    def __init__(self, chain_id: uuid.UUID) -> None:
        super().__init__(f"event chain {chain_id} is retracted", "id")


class EndRequired(ValidationFailed):
    def __init__(self, kind: str, prefix: str = "") -> None:
        super().__init__(f"{kind} needs ends_at", _at(prefix, "ends_at"))


class EndForbidden(ValidationFailed):
    def __init__(self, kind: str, prefix: str = "") -> None:
        super().__init__(f"{kind} has no ends_at", _at(prefix, "ends_at"))


class EndBeforeStart(ValidationFailed):
    def __init__(self, prefix: str = "") -> None:
        super().__init__("ends_at is before occurred_at", _at(prefix, "ends_at"))


class SelfLink(ValidationFailed):
    def __init__(self, field: str = "to_chain") -> None:
        super().__init__("an event cannot link to itself", field)


class LinkNotFound(NotFound):
    def __init__(self) -> None:
        super().__init__("no such link", "to_chain")


class InvalidRange(ValidationFailed):
    def __init__(self, message: str) -> None:
        super().__init__(message, "to_day")
```

- [ ] **Step 4: Implement the functions, routers and API**

`backend/app/features/journal/functions.py`:

```python
"""Journal logic: append facts, correct and retract chains, link them, read them back."""

import uuid
from collections.abc import Sequence
from datetime import date, datetime, timedelta
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.catalog.functions import recipe_items, snapshot
from app.features.journal.exceptions import (
    EndBeforeStart,
    EndForbidden,
    EndRequired,
    EventNotFound,
    EventRetracted,
    InvalidRange,
    LinkNotFound,
    SelfLink,
    StaleHead,
)
from app.features.journal.models import (
    ChainQuery,
    CorrectEvent,
    Event,
    EventHistory,
    EventLink,
    EventOut,
    EventsOut,
    LinkEvents,
    LinkOut,
    LinkResult,
    LogEvents,
    QueryEvents,
    RetractEvent,
)
from app.features.journal.payloads import KINDS, IntakeIn, IntakeItemStored, IntakeStored, current_payload
from app.features.profile.functions import timezone_at
from app.helpers.endpoints import Context
from app.helpers.errors import from_validation_errors
from app.helpers.models import Nutrients
from app.helpers.responses import Outcome
from app.helpers.time import local_day

MAX_RANGE_DAYS = 366


def _check_times(kind: str, occurred_at: datetime, ends_at: datetime | None, prefix: str) -> None:
    rule = KINDS[kind].ends
    if rule == "required" and ends_at is None:
        raise EndRequired(kind, prefix)
    if rule == "forbidden" and ends_at is not None:
        raise EndForbidden(kind, prefix)
    if ends_at is not None and ends_at < occurred_at:
        raise EndBeforeStart(prefix)


def _validate(kind: str, raw: dict[str, Any], field: str) -> BaseModel:
    try:
        return KINDS[kind].input.model_validate(raw)
    except ValidationError as exc:
        raise from_validation_errors(list(exc.errors()), field) from exc


async def _stored_payload(session: AsyncSession, kind: str, payload: BaseModel, field: str) -> dict[str, Any]:
    """The payload as stored; an intake is resolved and its nutrients snapshotted."""
    if not isinstance(payload, IntakeIn):
        return payload.model_dump(mode="json")
    portions = payload.portions
    recipe_version_id = None
    if payload.recipe_id is not None:
        portions = portions or 1
        recipe_version_id, pairs = await recipe_items(session, payload.recipe_id, portions, f"{field}.recipe_id")
    else:
        pairs = [(item.food_id, item.grams) for item in payload.items]
    items = await snapshot(session, pairs, f"{field}.items")
    stored = IntakeStored(
        slot=payload.slot,
        items=[IntakeItemStored(**item.model_dump(exclude={"kind"})) for item in items],
        recipe_id=payload.recipe_id,
        recipe_version_id=recipe_version_id,
        portions=portions,
        note=payload.note,
        nutrients=Nutrients.total(item.nutrients for item in items),
    )
    return stored.model_dump(mode="json")


async def _insert(
    ctx: Context,
    *,
    kind: str,
    occurred_at: datetime,
    ends_at: datetime | None,
    payload: dict[str, Any],
    source: str,
    previous: Event | None = None,
    external: tuple[str, str, str] | None = None,
) -> Event:
    """Add a new version: a new chain, or the successor of `previous`."""
    timezone = await timezone_at(ctx.session, occurred_at, ctx.settings.default_timezone)
    event_id = uuid.uuid4()
    external_source, external_id, content_hash = external or (None, None, None)
    event = Event(
        id=event_id,
        chain_id=previous.chain_id if previous else event_id,
        supersedes=previous.id if previous else None,
        version=previous.version + 1 if previous else 1,
        is_head=True,
        kind=kind,
        schema_version=KINDS[kind].version,
        occurred_at=occurred_at,
        ends_at=ends_at,
        local_day=local_day(occurred_at, timezone),
        payload=payload,
        source=source,
        external_source=external_source,
        external_id=external_id,
        content_hash=content_hash,
        recorded_at=ctx.now,
    )
    ctx.session.add(event)
    return event


async def _links(session: AsyncSession, chain_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, list[LinkOut]]:
    result: dict[uuid.UUID, list[LinkOut]] = {chain_id: [] for chain_id in chain_ids}
    if not chain_ids:
        return result
    rows = await session.scalars(
        select(EventLink).where(or_(EventLink.from_chain.in_(chain_ids), EventLink.to_chain.in_(chain_ids)))
    )
    for link in rows:
        if link.from_chain in result:
            result[link.from_chain].append(LinkOut(chain_id=link.to_chain, relation=link.relation, direction="outgoing"))
        if link.to_chain in result:
            result[link.to_chain].append(LinkOut(chain_id=link.from_chain, relation=link.relation, direction="incoming"))
    return result


def _out(event: Event, links: list[LinkOut] | None = None) -> EventOut:
    return EventOut(
        id=event.id,
        chain_id=event.chain_id,
        version=event.version,
        kind=event.kind,
        occurred_at=event.occurred_at,
        ends_at=event.ends_at,
        local_day=event.local_day,
        payload=current_payload(event.kind, event.schema_version, event.payload),
        source=event.source,
        recorded_at=event.recorded_at,
        retracted=event.retracted_at is not None,
        links=links or [],
    )


async def _outs(session: AsyncSession, events: Sequence[Event]) -> list[EventOut]:
    links = await _links(session, list({event.chain_id for event in events}))
    return [_out(event, links[event.chain_id]) for event in events]


async def _head(session: AsyncSession, event_id: uuid.UUID) -> Event:
    event = await session.get(Event, event_id)
    if event is None:
        raise EventNotFound(event_id)
    if not event.is_head:
        head_id = await session.scalar(select(Event.id).where(Event.chain_id == event.chain_id, Event.is_head))
        raise StaleHead(event_id, head_id)
    return event


async def _chain_head(session: AsyncSession, chain_id: uuid.UUID, field: str) -> Event:
    head = await session.scalar(select(Event).where(Event.chain_id == chain_id, Event.is_head))
    if head is None:
        raise EventNotFound(chain_id, field)
    return head


async def _add_link(session: AsyncSession, from_chain: uuid.UUID, to_chain: uuid.UUID, relation: str) -> None:
    await session.execute(
        insert(EventLink).values(from_chain=from_chain, to_chain=to_chain, relation=relation).on_conflict_do_nothing()
    )


async def log_events(ctx: Context, data: LogEvents) -> Outcome[EventsOut]:
    """Append each draft as a new chain, then its links."""
    created = []
    for index, draft in enumerate(data.events):
        prefix = f"events.{index}"
        _check_times(draft.kind, draft.occurred_at, draft.ends_at, prefix)
        payload = await _stored_payload(ctx.session, draft.kind, draft.payload, f"{prefix}.payload")
        created.append(
            await _insert(
                ctx,
                kind=draft.kind,
                occurred_at=draft.occurred_at,
                ends_at=draft.ends_at,
                payload=payload,
                source=ctx.principal.source,
            )
        )
    await ctx.session.flush()
    for index, draft in enumerate(data.events):
        for link_index, link in enumerate(draft.links):
            field = f"events.{index}.links.{link_index}.to_chain"
            if link.to_chain == created[index].chain_id:
                raise SelfLink(field)
            await _chain_head(ctx.session, link.to_chain, field)
            await _add_link(ctx.session, created[index].chain_id, link.to_chain, link.relation)
    return Outcome(EventsOut(events=await _outs(ctx.session, created)), days={e.local_day for e in created})


async def correct_event(ctx: Context, data: CorrectEvent) -> Outcome[EventOut]:
    """Write the next version of a chain with new times and/or a new payload."""
    old = await _head(ctx.session, data.id)
    if old.retracted_at is not None:
        raise EventRetracted(old.chain_id)
    sent = data.model_fields_set
    occurred_at = data.occurred_at if "occurred_at" in sent and data.occurred_at else old.occurred_at
    ends_at = data.ends_at if "ends_at" in sent else old.ends_at
    _check_times(old.kind, occurred_at, ends_at, "")
    if "payload" in sent and data.payload is not None:
        payload = await _stored_payload(ctx.session, old.kind, _validate(old.kind, data.payload, "payload"), "payload")
    else:
        payload = current_payload(old.kind, old.schema_version, old.payload)
    old.is_head = False
    await ctx.session.flush()
    external = (old.external_source, old.external_id, old.content_hash) if old.external_id else None
    new = await _insert(
        ctx,
        kind=old.kind,
        occurred_at=occurred_at,
        ends_at=ends_at,
        payload=payload,
        source=ctx.principal.source,
        previous=old,
        external=external,
    )
    await ctx.session.flush()
    return Outcome((await _outs(ctx.session, [new]))[0], days={old.local_day, new.local_day})


async def retract_event(ctx: Context, data: RetractEvent) -> Outcome[EventOut]:
    """Mark a chain as not counting; retracting twice changes nothing."""
    head = await _head(ctx.session, data.id)
    if head.retracted_at is None:
        head.retracted_at = ctx.now
        head.retract_reason = data.reason
        await ctx.session.flush()
    return Outcome((await _outs(ctx.session, [head]))[0], days={head.local_day})


async def link_events(ctx: Context, data: LinkEvents) -> Outcome[LinkResult]:
    """Relate two chains; linking twice changes nothing."""
    if data.from_chain == data.to_chain:
        raise SelfLink()
    source = await _chain_head(ctx.session, data.from_chain, "from_chain")
    target = await _chain_head(ctx.session, data.to_chain, "to_chain")
    await _add_link(ctx.session, data.from_chain, data.to_chain, data.relation)
    result = LinkResult(from_chain=data.from_chain, to_chain=data.to_chain, relation=data.relation)
    return Outcome(result, days={source.local_day, target.local_day})


async def unlink_events(ctx: Context, data: LinkEvents) -> Outcome[LinkResult]:
    """Remove a link."""
    result = await ctx.session.execute(
        delete(EventLink).where(
            EventLink.from_chain == data.from_chain,
            EventLink.to_chain == data.to_chain,
            EventLink.relation == data.relation,
        )
    )
    if result.rowcount == 0:
        raise LinkNotFound()
    return Outcome(LinkResult(from_chain=data.from_chain, to_chain=data.to_chain, relation=data.relation))


def _check_range(from_day: date, to_day: date) -> None:
    if to_day < from_day:
        raise InvalidRange("to_day is before from_day")
    if (to_day - from_day) >= timedelta(days=MAX_RANGE_DAYS):
        raise InvalidRange(f"a range covers at most {MAX_RANGE_DAYS} days")


async def heads_between(
    session: AsyncSession,
    from_day: date,
    to_day: date,
    kinds: Sequence[str] | None = None,
    include_retracted: bool = False,
) -> list[EventOut]:
    """Current versions whose local day lies in the range, in time order."""
    statement = (
        select(Event)
        .where(Event.is_head, Event.local_day.between(from_day, to_day))
        .order_by(Event.occurred_at, Event.id)
    )
    if kinds:
        statement = statement.where(Event.kind.in_(kinds))
    if not include_retracted:
        statement = statement.where(Event.retracted_at.is_(None))
    return await _outs(session, (await session.scalars(statement)).all())


async def query_events(ctx: Context, data: QueryEvents) -> EventsOut:
    """Current versions between two local days, optionally of some kinds."""
    _check_range(data.from_day, data.to_day)
    return EventsOut(
        events=await heads_between(ctx.session, data.from_day, data.to_day, data.kinds, data.include_retracted)
    )


async def get_event_history(ctx: Context, data: ChainQuery) -> EventHistory:
    """Every version of a chain, oldest first, with its links."""
    rows = (await ctx.session.scalars(select(Event).where(Event.chain_id == data.chain_id).order_by(Event.version))).all()
    if not rows:
        raise EventNotFound(data.chain_id, "chain_id")
    links = (await _links(ctx.session, [data.chain_id]))[data.chain_id]
    return EventHistory(chain_id=data.chain_id, kind=rows[0].kind, versions=[_out(row, links) for row in rows], links=links)
```

`backend/app/features/journal/routers.py`:

```python
"""The journal feature's endpoints."""

from app.features.catalog.exceptions import FoodArchived, FoodNotFound, RecipeArchived, RecipeNotFound
from app.features.journal import functions
from app.features.journal.exceptions import (
    EndBeforeStart,
    EndForbidden,
    EndRequired,
    EventNotFound,
    EventRetracted,
    InvalidRange,
    LinkNotFound,
    SelfLink,
    StaleHead,
)
from app.features.journal.models import (
    ChainQuery,
    CorrectEvent,
    EventHistory,
    EventOut,
    EventsOut,
    LinkEvents,
    LinkResult,
    LogEvents,
    QueryEvents,
    RetractEvent,
)
from app.helpers.endpoints import command, query

_TIME_ERRORS = (EndRequired, EndForbidden, EndBeforeStart)
_FOOD_ERRORS = (FoodNotFound, FoodArchived, RecipeNotFound, RecipeArchived)

OPERATIONS = (
    command(
        "log_events",
        LogEvents,
        EventsOut,
        functions.log_events,
        "Log 1-50 facts about the owner's body and day. Each event has kind, occurred_at (ISO with "
        "offset), optional ends_at (required for sleep and activity), payload (shape per kind; see "
        "get_schemas or the daily://schema/{kind} resources) and optional links to earlier chains, "
        "e.g. a symptom with relation suspected_cause to an intake. An intake lists items "
        "(food_id from find_food, grams) or a recipe_id with portions.",
        errors=(EventNotFound, SelfLink, *_TIME_ERRORS, *_FOOD_ERRORS),
    ),
    command(
        "correct_event",
        CorrectEvent,
        EventOut,
        functions.correct_event,
        "Correct a fact: send the current version's id and the new occurred_at/ends_at and/or the "
        "whole new payload. The old version stays in history; links survive.",
        errors=(EventNotFound, StaleHead, EventRetracted, *_TIME_ERRORS, *_FOOD_ERRORS),
    ),
    command(
        "retract_event",
        RetractEvent,
        EventOut,
        functions.retract_event,
        "Retract a fact logged by mistake (current version's id). It stops counting everywhere but "
        "stays in history.",
        errors=(EventNotFound, StaleHead),
        destructive=True,
    ),
    command(
        "link_events",
        LinkEvents,
        LinkResult,
        functions.link_events,
        "Relate two chains, e.g. a symptom (from) suspected_cause an intake (to).",
        errors=(EventNotFound, SelfLink),
    ),
    command(
        "unlink_events",
        LinkEvents,
        LinkResult,
        functions.unlink_events,
        "Remove a link between two chains.",
        errors=(LinkNotFound,),
        destructive=True,
    ),
    query(
        "query_events",
        QueryEvents,
        EventsOut,
        functions.query_events,
        "Read facts between two local days (at most 366), optionally filtered by kind, with links. "
        "Use it for analyses across days.",
        errors=(InvalidRange,),
    ),
    query(
        "get_event_history",
        ChainQuery,
        EventHistory,
        functions.get_event_history,
        "Every version of one fact (chain), oldest first, with its links.",
        errors=(EventNotFound,),
        view="event",
    ),
)
```

`backend/app/features/journal/journal.py`:

```python
"""The journal feature's API; payload schemas are published per kind."""

from app.features.journal.payloads import KINDS
from app.features.journal.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(name="journal", operations=OPERATIONS, schemas={kind: spec.input for kind, spec in KINDS.items()})
```

In `backend/app/main.py`, add `from app.features.journal.journal import api as journal` and set:

```python
FEATURES: tuple[FeatureApi, ...] = (profile, catalog, journal)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_writing.py`: `13 passed`)

- [ ] **Step 6: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(journal): append-only events with correction chains, retraction and links

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Reading the journal and syncing external facts

**Files:**
- Modify: `backend/app/features/journal/functions.py` (append the functions below)
- Test: `backend/tests/features/journal/test_reading.py`, `backend/tests/features/journal/test_external.py`

**Interfaces:**
- Consumes: Task 11.
- Produces (for days and integrations):
  - `latest_measurement(session, metric: str, on_or_before: date) -> EventOut | None`
  - `measurements(session, metric: str, from_day: date, to_day: date) -> list[EventOut]`
  - `days_with_events(session, before: date | None, limit: int, kinds: Sequence[str] | None = None) -> list[date]`
  - `REMOVED_AT_SOURCE = "removed at source"`
  - `upsert_external(ctx, source: str, draft: ExternalDraft) -> tuple[Literal["created","corrected","unchanged"], set[date]]`
  - `retract_missing(ctx, source: str, since: datetime, seen: set[str]) -> tuple[int, set[date]]` (the number retracted and the days touched)

- [ ] **Step 1: Write the failing tests**

`backend/tests/features/journal/test_reading.py`:

```python
from datetime import date

from app.features.journal.functions import days_with_events, latest_measurement, measurements
from tests.clients import call_tool, call_tool_error
from tests.conftest import requires_db
from tests.features.journal.helpers import draft, logged

pytestmark = requires_db


def weight(value: float, at: str) -> dict:
    return draft("measurement", {"metric": "weight_kg", "value": value}, occurred_at=at)


async def test_latest_measurement_and_series(rest, db):
    await logged(rest, weight(85.5, "2026-09-28T07:00:00+02:00"), weight(84.3, "2026-09-29T07:00:00+02:00"), weight(99, "2026-10-05T07:00:00+02:00"))
    latest = await latest_measurement(db, "weight_kg", date(2026, 9, 30))
    assert latest.payload["value"] == 84.3
    assert await latest_measurement(db, "hrv_ms", date(2026, 9, 30)) is None
    series = await measurements(db, "weight_kg", date(2026, 9, 28), date(2026, 9, 29))
    assert [e.payload["value"] for e in series] == [85.5, 84.3]


async def test_days_with_events_pages_backwards(rest, db):
    await logged(rest, draft("note", {"text": "a"}, occurred_at="2026-09-20T10:00:00Z"), draft("note", {"text": "b"}, occurred_at="2026-09-25T10:00:00Z"), draft("checkin", {"overall": 3}, occurred_at="2026-09-27T10:00:00Z"))
    assert await days_with_events(db, None, 2) == [date(2026, 9, 27), date(2026, 9, 25)]
    assert await days_with_events(db, date(2026, 9, 25), 5) == [date(2026, 9, 20)]
    assert await days_with_events(db, None, 5, kinds=["checkin"]) == [date(2026, 9, 27)]


async def test_query_events_through_mcp_with_filters_and_range_checks(mcp, rest):
    note, _ = await logged(rest, draft("note", {"text": "a"}), draft("checkin", {"overall": 2}))
    await rest.post("/api/v2/commands/retract_event", json={"id": note["id"]})
    async with mcp() as client:
        visible = await call_tool(client, "query_events", {"from_day": "2026-09-30", "to_day": "2026-09-30"})
        assert [e["kind"] for e in visible["events"]] == ["checkin"]
        everything = await call_tool(client, "query_events", {"from_day": "2026-09-30", "to_day": "2026-09-30", "include_retracted": True})
        assert len(everything["events"]) == 2
        only = await call_tool(client, "query_events", {"from_day": "2026-09-30", "to_day": "2026-09-30", "kinds": ["note"], "include_retracted": True})
        assert [e["kind"] for e in only["events"]] == ["note"]
        backwards = await call_tool_error(client, "query_events", {"from_day": "2026-09-30", "to_day": "2026-09-01"})
        assert backwards["field"] == "to_day"
        too_long = await call_tool_error(client, "query_events", {"from_day": "2025-01-01", "to_day": "2026-09-30"})
    assert too_long["message"] == "a range covers at most 366 days"


async def test_history_of_an_unknown_chain_is_not_found(rest):
    response = await rest.get("/api/v2/views/event", params={"chain_id": "00000000-0000-0000-0000-000000000009"})
    assert (response.status_code, response.json()["field"]) == (404, "chain_id")
```

`backend/tests/features/journal/test_external.py`:

```python
from datetime import UTC, datetime

from sqlalchemy import select

from app.features.journal.functions import REMOVED_AT_SOURCE, retract_missing, upsert_external
from app.features.journal.models import Event, ExternalDraft
from app.helpers.auth import SYSTEM
from app.helpers.config import get_settings
from app.helpers.endpoints import Context
from app.helpers.time import utcnow
from tests.conftest import requires_db

pytestmark = requires_db


def _ctx(db) -> Context:
    return Context(session=db, principal=SYSTEM, settings=get_settings(), now=utcnow())


def _workout(external_id: str, volume: float, started: str = "2026-09-28T17:00:00Z") -> ExternalDraft:
    return ExternalDraft(
        external_id=external_id,
        content_hash=f"hash-{volume}",
        kind="workout",
        occurred_at=started,
        ends_at="2026-09-28T17:31:00Z",
        payload={"title": "Push", "category": "strength", "volume_kg": volume},
    )


async def _heads(db, source: str) -> list[Event]:
    return list((await db.scalars(select(Event).where(Event.external_source == source, Event.is_head))).all())


async def test_create_then_unchanged_then_corrected(db):
    ctx = _ctx(db)
    assert (await upsert_external(ctx, "gym-bro", _workout("w1", 1000)))[0] == "created"
    assert (await upsert_external(ctx, "gym-bro", _workout("w1", 1000)))[0] == "unchanged"
    status, days = await upsert_external(ctx, "gym-bro", _workout("w1", 1200))
    assert (status, days) == ("corrected", {datetime(2026, 9, 28).date()})
    [head] = await _heads(db, "gym-bro")
    assert (head.version, head.payload["volume_kg"], head.source) == (2, 1200, "gym-bro")


async def test_missing_inside_the_window_is_retracted_and_restored_when_it_returns(db):
    ctx = _ctx(db)
    await upsert_external(ctx, "gym-bro", _workout("w1", 1000))
    await upsert_external(ctx, "gym-bro", _workout("w2", 500, started="2026-09-01T17:00:00Z"))
    count, days = await retract_missing(ctx, "gym-bro", datetime(2026, 9, 14, tzinfo=UTC), seen=set())
    assert (count, days) == (1, {datetime(2026, 9, 28).date()})
    heads = {h.external_id: h for h in await _heads(db, "gym-bro")}
    assert heads["w1"].retract_reason == REMOVED_AT_SOURCE
    assert heads["w2"].retracted_at is None
    assert (await upsert_external(ctx, "gym-bro", _workout("w1", 1000)))[0] == "corrected"
    restored = {h.external_id: h for h in await _heads(db, "gym-bro")}["w1"]
    assert restored.retracted_at is None


async def test_owner_retraction_is_respected(db):
    ctx = _ctx(db)
    await upsert_external(ctx, "gym-bro", _workout("w1", 1000))
    [head] = await _heads(db, "gym-bro")
    head.retracted_at = utcnow()
    head.retract_reason = "test session"
    await db.flush()
    assert (await upsert_external(ctx, "gym-bro", _workout("w1", 1000)))[0] == "unchanged"
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/journal/test_reading.py tests/features/journal/test_external.py -q`
Expected: FAIL with `ImportError: cannot import name 'days_with_events'`

- [ ] **Step 3: Implement**

Append to `backend/app/features/journal/functions.py`. Add `from typing import Literal` to
the imports and `ExternalDraft` to the `app.features.journal.models` import.

```python
REMOVED_AT_SOURCE = "removed at source"


def _measurement_statement(metric: str):
    return select(Event).where(
        Event.is_head,
        Event.retracted_at.is_(None),
        Event.kind == "measurement",
        Event.payload["metric"].astext == metric,
    )


async def latest_measurement(session: AsyncSession, metric: str, on_or_before: date) -> EventOut | None:
    """The newest value of a metric on or before a local day."""
    row = await session.scalar(
        _measurement_statement(metric).where(Event.local_day <= on_or_before).order_by(Event.occurred_at.desc()).limit(1)
    )
    return _out(row) if row else None


async def measurements(session: AsyncSession, metric: str, from_day: date, to_day: date) -> list[EventOut]:
    """A metric's values between two local days, in time order."""
    rows = await session.scalars(
        _measurement_statement(metric).where(Event.local_day.between(from_day, to_day)).order_by(Event.occurred_at)
    )
    return [_out(row) for row in rows]


async def days_with_events(
    session: AsyncSession, before: date | None, limit: int, kinds: Sequence[str] | None = None
) -> list[date]:
    """Local days that have counting events, newest first, strictly before `before`."""
    statement = (
        select(Event.local_day)
        .where(Event.is_head, Event.retracted_at.is_(None))
        .distinct()
        .order_by(Event.local_day.desc())
        .limit(limit)
    )
    if before is not None:
        statement = statement.where(Event.local_day < before)
    if kinds:
        statement = statement.where(Event.kind.in_(kinds))
    return list((await session.scalars(statement)).all())


async def upsert_external(
    ctx: Context, source: str, draft: ExternalDraft
) -> tuple[Literal["created", "corrected", "unchanged"], set[date]]:
    """Create or correct the chain for a source's id; the owner's own retraction is kept."""
    head = await ctx.session.scalar(
        select(Event).where(Event.external_source == source, Event.external_id == draft.external_id, Event.is_head)
    )
    if head is not None and head.content_hash == draft.content_hash:
        if head.retracted_at is None or head.retract_reason != REMOVED_AT_SOURCE:
            return "unchanged", set()
    _check_times(draft.kind, draft.occurred_at, draft.ends_at, "")
    payload = await _stored_payload(ctx.session, draft.kind, _validate(draft.kind, draft.payload, "payload"), "payload")
    if head is not None:
        head.is_head = False
        await ctx.session.flush()
    event = await _insert(
        ctx,
        kind=draft.kind,
        occurred_at=draft.occurred_at,
        ends_at=draft.ends_at,
        payload=payload,
        source=source,
        previous=head,
        external=(source, draft.external_id, draft.content_hash),
    )
    await ctx.session.flush()
    if head is None:
        return "created", {event.local_day}
    return "corrected", {head.local_day, event.local_day}


async def retract_missing(ctx: Context, source: str, since: datetime, seen: set[str]) -> tuple[int, set[date]]:
    """Retract the source's counting chains from `since` on that the source no longer returns."""
    rows = await ctx.session.scalars(
        select(Event).where(
            Event.external_source == source,
            Event.is_head,
            Event.retracted_at.is_(None),
            Event.occurred_at >= since,
        )
    )
    count = 0
    days = set()
    for event in rows:
        if event.external_id not in seen:
            event.retracted_at = ctx.now
            event.retract_reason = REMOVED_AT_SOURCE
            count += 1
            days.add(event.local_day)
    await ctx.session.flush()
    return count, days
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_reading.py`: `4 passed`, `test_external.py`: `3 passed`)

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(journal): measurement and day reads, external upsert and source retraction

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 13: Feature `integrations` (adapter runner and gym-bro)

**Files:**
- Create: `backend/app/features/integrations/__init__.py` (empty), `models.py`, `exceptions.py`, `services.py`, `adapters.py`, `functions.py`, `routers.py`, `integrations.py`
- Modify: `backend/app/main.py` (add the API to `FEATURES`)
- Test: `backend/tests/features/integrations/__init__.py` (empty), `backend/tests/features/integrations/fakes.py`, `backend/tests/features/integrations/test_gym_bro.py`, `backend/tests/features/integrations/test_runner.py`

**Interfaces:**
- Consumes: `upsert_external`, `retract_missing` and `ExternalDraft` (Tasks 11–12);
  `ClientCredentials` and `SYSTEM` (Task 4); `services` (Task 5); `execute` (Task 6);
  `try_advisory_xact_lock` and `open_session` (Task 3).
- Produces:
  - Table `SyncState` (`sync_state`)
  - Models `SyncStatusOut(source, configured, last_attempt_at, last_success_at, last_error, counts)`
    and `SyncNow(source)`
  - `FetchResult(drafts, cursor, covered_since)`, the protocol
    `SourceAdapter(name, interval_seconds, authoritative, fetch(cursor, now))`,
    `GymBroAdapter`, `workout_draft(session: dict) -> ExternalDraft`,
    `configured_adapters(settings) -> dict[str, SourceAdapter]` and
    `override_adapters(adapters | None)`
  - `GymBroClient(http, base_url, tokens)` with
    `completed_sessions(user_id, completed_after) -> list[dict]`, and `gym_bro() -> GymBroClient`
  - `run_adapter(ctx, adapter) -> tuple[SyncStatusOut, set[date]]`,
    `sync_status(session, settings) -> list[SyncStatusOut]`, and the command `sync_now`
  - the exception `UnknownSource`
  - `integrations.api`, whose lifespan runs one background loop per configured adapter
    (first run after 30 s, then every `interval_seconds`) through `execute(sync_now, SYSTEM, ...)`

A new source such as the ring (sub-project 5) is one new adapter class plus one entry in
`configured_adapters`. Nothing else changes.

- [ ] **Step 1: Write the fakes and failing tests**

`backend/tests/features/integrations/fakes.py`:

```python
"""A controllable in-memory source."""

from datetime import UTC, datetime

from app.features.integrations.adapters import FetchResult
from app.features.journal.models import ExternalDraft
from app.helpers.errors import Upstream


def workout(external_id: str, volume: float = 1000, started: str = "2026-09-28T17:00:00Z") -> ExternalDraft:
    return ExternalDraft(
        external_id=external_id,
        content_hash=f"{external_id}-{volume}",
        kind="workout",
        occurred_at=started,
        ends_at="2026-09-28T17:31:00Z",
        payload={"title": "Push", "category": "strength", "volume_kg": volume},
    )


COVERED_SINCE = datetime(2026, 9, 1, tzinfo=UTC)


class FakeAdapter:
    """Returns `drafts`; `fail=True` raises like an unreachable source."""

    name = "fake"
    interval_seconds = 3600
    authoritative = True

    def __init__(self, drafts: list[ExternalDraft] | None = None) -> None:
        self.drafts = drafts or []
        self.fail = False
        self.cursors: list[str | None] = []

    async def fetch(self, cursor: str | None, now: datetime) -> FetchResult:
        self.cursors.append(cursor)
        if self.fail:
            raise Upstream("fake source is down")
        return FetchResult(drafts=list(self.drafts), cursor=now.isoformat(), covered_since=COVERED_SINCE)
```

`backend/tests/features/integrations/test_gym_bro.py`:

```python
from datetime import UTC, datetime

import httpx
import pytest

from app.features.integrations.adapters import workout_draft
from app.features.integrations.services import GymBroClient
from app.helpers.auth import ClientCredentials
from app.helpers.errors import Upstream

SESSION = {
    "id": "6f1c1a52-0000-0000-0000-000000000001",
    "name": "Push A",
    "started_at": "2026-09-28T17:00:00+00:00",
    "completed_at": "2026-09-28T17:31:00+00:00",
    "exercises": [
        {"order": 1, "exercise": {"name": "Bench", "category": None, "muscle_group": "chest"}, "sets": [
            {"order": 1, "completed": True, "set_type": "working_set", "weight": 80, "reps": 8, "duration_seconds": None, "rpe": 8},
            {"order": 2, "completed": False, "set_type": "working_set", "weight": 80, "reps": 8, "duration_seconds": None, "rpe": None},
        ]},
        {"order": 0, "exercise": {"name": "Rower", "category": None, "muscle_group": "cardio"}, "sets": [
            {"order": 1, "completed": True, "set_type": "working_set", "weight": None, "reps": None, "duration_seconds": 600, "rpe": 6},
        ]},
    ],
}


def test_workout_draft_maps_completed_sets_and_categories():
    draft = workout_draft(SESSION)
    assert (draft.external_id, draft.kind) == (SESSION["id"], "workout")
    assert draft.payload["category"] == "mixed"
    assert draft.payload["set_count"] == 2
    assert draft.payload["volume_kg"] == 640
    assert [e["name"] for e in draft.payload["exercises"]] == ["Rower", "Bench"]
    assert draft.payload["exercises"][1]["sets"] == [{"reps": 8, "weight_kg": 80, "duration_s": None, "rpe": 8}]


def test_content_hash_is_stable_and_changes_with_content():
    assert workout_draft(SESSION).content_hash == workout_draft(SESSION).content_hash
    heavier = {**SESSION, "name": "Push B"}
    assert workout_draft(heavier).content_hash != workout_draft(SESSION).content_hash


async def test_client_pages_with_a_service_token():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "svc", "expires_in": 300})
        assert request.headers["authorization"] == "Bearer svc"
        offset = int(request.url.params["offset"])
        seen.append(offset)
        return httpx.Response(200, json=[SESSION] * (100 if offset == 0 else 1))

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = GymBroClient(http, "http://gym", ClientCredentials("http://kc/token", "svc", "s", http))
    sessions = await client.completed_sessions("owner", datetime(2026, 9, 1, tzinfo=UTC))
    assert (len(sessions), seen) == (101, [0, 100])
    await client.aclose()


async def test_client_failures_are_upstream():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "svc", "expires_in": 300})
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = GymBroClient(http, "http://gym", ClientCredentials("http://kc/token", "svc", "s", http))
    with pytest.raises(Upstream):
        await client.completed_sessions("owner", datetime(2026, 9, 1, tzinfo=UTC))
```

`backend/tests/features/integrations/test_runner.py`:

```python
from datetime import date

import pytest

from app.features.integrations.adapters import override_adapters
from app.features.integrations.functions import run_adapter, sync_status
from app.features.journal.functions import heads_between
from app.helpers.auth import SYSTEM
from app.helpers.config import get_settings
from app.helpers.endpoints import Context
from app.helpers.time import utcnow
from tests.conftest import requires_db
from tests.features.integrations.fakes import FakeAdapter, workout

pytestmark = requires_db


@pytest.fixture
def fake():
    adapter = FakeAdapter([workout("w1"), workout("w2", 500)])
    override_adapters({"fake": adapter})
    yield adapter
    override_adapters(None)


def _ctx(db) -> Context:
    return Context(session=db, principal=SYSTEM, settings=get_settings(), now=utcnow())


async def test_first_run_creates_then_repeats_are_unchanged(db, fake):
    status, days = await run_adapter(_ctx(db), fake)
    assert status.counts["created"] == 2
    assert status.last_error is None
    assert days
    again, _ = await run_adapter(_ctx(db), fake)
    assert again.counts == {"created": 0, "corrected": 0, "unchanged": 2, "retracted": 0, "invalid": 0}
    assert fake.cursors[0] is None and fake.cursors[1] is not None


async def test_missing_items_are_retracted_and_bad_items_skipped(db, fake):
    await run_adapter(_ctx(db), fake)
    fake.drafts = [workout("w1"), workout("bad").model_copy(update={"payload": {"title": ""}})]
    status, _ = await run_adapter(_ctx(db), fake)
    assert (status.counts["retracted"], status.counts["invalid"]) == (1, 1)
    events = await heads_between(db, date(2026, 9, 28), date(2026, 9, 28))
    assert [e.payload["volume_kg"] for e in events] == [1000]


async def test_a_failing_source_records_the_error_and_keeps_data(db, fake):
    await run_adapter(_ctx(db), fake)
    fake.fail = True
    status, days = await run_adapter(_ctx(db), fake)
    assert (status.last_error, days) == ("fake source is down", set())
    assert status.counts["created"] == 2
    [listed] = await sync_status(db, get_settings())
    assert (listed.source, listed.configured, listed.last_error) == ("fake", True, "fake source is down")


async def test_sync_now_over_rest(rest, fake):
    ok = (await rest.post("/api/v2/commands/sync_now", json={"source": "fake"})).json()
    assert ok["result"]["counts"]["created"] == 2
    unknown = await rest.post("/api/v2/commands/sync_now", json={"source": "ring"})
    assert (unknown.status_code, unknown.json()["field"]) == (404, "source")
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/integrations -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.features.integrations'`

- [ ] **Step 3: Implement the models, exceptions, services and adapters**

`backend/app/features/integrations/models.py`:

```python
"""Sync bookkeeping and the integration feature's own models."""

from datetime import datetime
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel, Field
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base
from app.helpers.models import CommandInput


class SyncState(Base):
    """Where each source's sync stands."""

    __tablename__ = "sync_state"

    source: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    cursor: Mapped[str | None] = mapped_column(sa.Text)
    last_attempt_at: Mapped[datetime | None]
    last_success_at: Mapped[datetime | None]
    last_error: Mapped[str | None] = mapped_column(sa.String(500))
    last_counts: Mapped[dict[str, Any]] = mapped_column(default=dict)


class SyncStatusOut(BaseModel):
    """A source's sync status and the counts of its last successful run."""

    source: str
    configured: bool
    last_attempt_at: datetime | None
    last_success_at: datetime | None
    last_error: str | None
    counts: dict[str, int]


class SyncNow(CommandInput):
    """Run one source's sync immediately."""

    source: str = Field(min_length=1, max_length=64, description="e.g. gym-bro")
```

`backend/app/features/integrations/exceptions.py`:

```python
"""Every error the integrations feature raises."""

from app.helpers.errors import NotFound


class UnknownSource(NotFound):
    def __init__(self, source: str) -> None:
        super().__init__(f"no configured source named {source}", "source")
```

`backend/app/features/integrations/services.py`:

```python
"""gym-bro's export API, authenticated as daily's Keycloak service account."""

from datetime import datetime
from typing import Any

import httpx

from app.helpers.auth import ClientCredentials
from app.helpers.config import get_settings
from app.helpers.errors import Upstream
from app.helpers.services import services

_PAGE = 100
_EXPORT_PATH = "/api/v1/export/workouts"


class GymBroClient:
    """Pages through completed workout sessions."""

    def __init__(self, http: httpx.AsyncClient, base_url: str, tokens: ClientCredentials) -> None:
        self._http = http
        self._base_url = base_url.rstrip("/")
        self._tokens = tokens

    async def _page(self, user_id: str, completed_after: datetime, offset: int) -> list[dict[str, Any]]:
        token = await self._tokens.token()
        try:
            response = await self._http.get(
                f"{self._base_url}{_EXPORT_PATH}",
                params={"user_id": user_id, "completed_after": completed_after.isoformat(), "limit": _PAGE, "offset": offset},
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise Upstream("gym-bro did not answer") from exc
        if not isinstance(body, list):
            raise Upstream("gym-bro answered with an unexpected shape")
        return body

    async def completed_sessions(self, user_id: str, completed_after: datetime) -> list[dict[str, Any]]:
        """Every session the user completed after the given instant, oldest first."""
        sessions: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = await self._page(user_id, completed_after, offset)
            sessions.extend(page)
            if len(page) < _PAGE:
                return sessions
            offset += _PAGE

    async def aclose(self) -> None:
        """Close the HTTP client (shared with the token provider)."""
        await self._http.aclose()


def _build() -> GymBroClient:
    settings = get_settings()
    http = httpx.AsyncClient(timeout=20)
    tokens = ClientCredentials(settings.keycloak_token_url, settings.gym_bro_client_id, settings.gym_bro_client_secret, http)
    return GymBroClient(http, settings.gym_bro_url, tokens)


services.register("gym-bro", _build)


def gym_bro() -> GymBroClient:
    """The gym-bro client in use."""
    return services.get("gym-bro")
```

`backend/app/features/integrations/adapters.py`:

```python
"""Source adapters: fetch from an external system and map to ExternalDrafts, nothing more."""

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from app.features.integrations.services import GymBroClient, gym_bro
from app.features.journal.models import ExternalDraft
from app.helpers.config import Settings

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class FetchResult:
    """What one fetch returned, the cursor for next time, and the span it fully covers."""

    drafts: list[ExternalDraft]
    cursor: str
    covered_since: datetime | None


class SourceAdapter(Protocol):
    """An external source. `authoritative` sources retract what they stop returning."""

    name: str
    interval_seconds: int
    authoritative: bool

    async def fetch(self, cursor: str | None, now: datetime) -> FetchResult: ...


def _order(item: dict[str, Any]) -> int:
    return int(item.get("order") or 0)


def _category(categories: set[str]) -> str:
    if not categories:
        return "other"
    if categories == {"cardio"}:
        return "cardio"
    return "mixed" if "cardio" in categories else "strength"


def workout_draft(session: dict[str, Any]) -> ExternalDraft:
    """A gym-bro session as a workout event; only completed sets count."""
    exercises = []
    set_count = 0
    volume = 0.0
    categories: set[str] = set()
    for exercise in sorted(session.get("exercises") or [], key=_order):
        info = exercise.get("exercise") or {}
        category = info.get("category") or ("cardio" if info.get("muscle_group") == "cardio" else "strength")
        categories.add(category)
        sets = [s for s in sorted(exercise.get("sets") or [], key=_order) if s.get("completed")]
        set_count += len(sets)
        volume += sum(s["weight"] * s["reps"] for s in sets if s.get("weight") is not None and s.get("reps") is not None)
        exercises.append(
            {
                "name": info.get("name") or "exercise",
                "category": category,
                "sets": [
                    {"reps": s.get("reps"), "weight_kg": s.get("weight"), "duration_s": s.get("duration_seconds"), "rpe": s.get("rpe")}
                    for s in sets
                ],
            }
        )
    payload = {
        "title": session.get("name") or "Workout",
        "category": _category(categories),
        "set_count": set_count,
        "volume_kg": round(volume, 1),
        "exercises": exercises,
    }
    fingerprint = json.dumps(
        {"payload": payload, "started_at": session["started_at"], "completed_at": session["completed_at"]},
        sort_keys=True,
    )
    return ExternalDraft(
        external_id=str(session["id"]),
        content_hash=hashlib.sha256(fingerprint.encode()).hexdigest(),
        kind="workout",
        occurred_at=session["started_at"],
        ends_at=session["completed_at"],
        payload=payload,
    )


class GymBroAdapter:
    """gym-bro is the source of truth for workouts in the last 14 days."""

    name = "gym-bro"
    authoritative = True
    window = timedelta(days=14)

    def __init__(self, client: GymBroClient, owner_sub: str, interval_seconds: int) -> None:
        self._client = client
        self._owner_sub = owner_sub
        self.interval_seconds = interval_seconds

    async def fetch(self, cursor: str | None, now: datetime) -> FetchResult:
        since = EPOCH if cursor is None else now - self.window
        sessions = await self._client.completed_sessions(self._owner_sub, since)
        return FetchResult(drafts=[workout_draft(s) for s in sessions], cursor=now.isoformat(), covered_since=since)


_override: dict[str, SourceAdapter] | None = None


def configured_adapters(settings: Settings) -> dict[str, SourceAdapter]:
    """Every source that is configured, by name."""
    if _override is not None:
        return _override
    adapters: dict[str, SourceAdapter] = {}
    if settings.gym_bro_url and settings.gym_bro_client_secret:
        adapters["gym-bro"] = GymBroAdapter(gym_bro(), settings.owner_sub, settings.gym_bro_interval_seconds)
    return adapters


def override_adapters(adapters: dict[str, SourceAdapter] | None) -> None:
    """Use these adapters instead of the configured ones (tests); None restores them."""
    global _override
    _override = adapters
```

- [ ] **Step 4: Implement the functions, routers and API**

`backend/app/features/integrations/functions.py`:

```python
"""Running an adapter: fetch without holding a lock, then apply under one."""

import zlib
from datetime import date

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.integrations.adapters import SourceAdapter, configured_adapters
from app.features.integrations.exceptions import UnknownSource
from app.features.integrations.models import SyncNow, SyncState, SyncStatusOut
from app.features.journal.functions import retract_missing, upsert_external
from app.helpers.config import Settings
from app.helpers.database import try_advisory_xact_lock
from app.helpers.endpoints import Context
from app.helpers.errors import AppError, Upstream
from app.helpers.logging import get_logger
from app.helpers.responses import Outcome

logger = get_logger("integrations")

_LOCK_BASE = 0x6461696C
COUNT_KEYS = ("created", "corrected", "unchanged", "retracted", "invalid")


def _lock_key(source: str) -> int:
    return _LOCK_BASE ^ zlib.crc32(source.encode())


def _status(source: str, configured: bool, state: SyncState | None) -> SyncStatusOut:
    return SyncStatusOut(
        source=source,
        configured=configured,
        last_attempt_at=state.last_attempt_at if state else None,
        last_success_at=state.last_success_at if state else None,
        last_error=state.last_error if state else None,
        counts=dict(state.last_counts) if state and state.last_counts else {},
    )


async def _state(session: AsyncSession, source: str) -> SyncState:
    state = await session.get(SyncState, source)
    if state is None:
        state = SyncState(source=source, last_counts={})
        session.add(state)
    return state


async def run_adapter(ctx: Context, adapter: SourceAdapter) -> tuple[SyncStatusOut, set[date]]:
    """One sync: a failed fetch changes no data; a concurrent run is skipped."""
    state = await _state(ctx.session, adapter.name)
    state.last_attempt_at = ctx.now
    try:
        result = await adapter.fetch(state.cursor, ctx.now)
    except Upstream as exc:
        state.last_error = exc.message[:500]
        await ctx.session.flush()
        return _status(adapter.name, True, state), set()
    if not await try_advisory_xact_lock(ctx.session, _lock_key(adapter.name)):
        return _status(adapter.name, True, state), set()
    counts = dict.fromkeys(COUNT_KEYS, 0)
    days: set[date] = set()
    for draft in result.drafts:
        try:
            outcome, touched = await upsert_external(ctx, adapter.name, draft)
        except (AppError, ValidationError) as exc:
            counts["invalid"] += 1
            logger.warning("skipped an invalid item", extra={"context": {"source": adapter.name, "id": draft.external_id, "error": str(exc)}})
            continue
        counts[outcome] += 1
        days |= touched
    if adapter.authoritative and result.covered_since is not None:
        retracted, removed_days = await retract_missing(
            ctx, adapter.name, result.covered_since, {d.external_id for d in result.drafts}
        )
        counts["retracted"] = retracted
        days |= removed_days
    state.cursor = result.cursor
    state.last_success_at = ctx.now
    state.last_error = None
    state.last_counts = counts
    await ctx.session.flush()
    return _status(adapter.name, True, state), days


async def sync_status(session: AsyncSession, settings: Settings) -> list[SyncStatusOut]:
    """Every configured source's status, plus sources that synced before but are no longer configured."""
    configured = configured_adapters(settings)
    states = {s.source: s for s in await session.scalars(select(SyncState))}
    names = sorted(set(configured) | set(states))
    return [_status(name, name in configured, states.get(name)) for name in names]


async def sync_now(ctx: Context, data: SyncNow) -> Outcome[SyncStatusOut]:
    """Run one configured source now."""
    adapter = configured_adapters(ctx.settings).get(data.source)
    if adapter is None:
        raise UnknownSource(data.source)
    status, days = await run_adapter(ctx, adapter)
    warnings = [f"{data.source} sync failed: {status.last_error}"] if status.last_error else []
    return Outcome(status, days=days, warnings=warnings)
```

`backend/app/features/integrations/routers.py`:

```python
"""The integrations feature's endpoints."""

from app.features.integrations import functions
from app.features.integrations.exceptions import UnknownSource
from app.features.integrations.models import SyncNow, SyncStatusOut
from app.helpers.endpoints import command

SYNC_NOW = command(
    "sync_now",
    SyncNow,
    SyncStatusOut,
    functions.sync_now,
    "Run one external source's sync now (e.g. gym-bro) and return its status and counts.",
    errors=(UnknownSource,),
)

OPERATIONS = (SYNC_NOW,)
```

`backend/app/features/integrations/integrations.py`:

```python
"""The integrations feature's API; its lifespan runs one sync loop per configured source."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Any

from app.features.integrations.adapters import SourceAdapter, configured_adapters
from app.features.integrations.models import SyncNow
from app.features.integrations.routers import OPERATIONS, SYNC_NOW
from app.helpers.auth import SYSTEM
from app.helpers.config import get_settings
from app.helpers.endpoints import FeatureApi, execute
from app.helpers.logging import get_logger

logger = get_logger("integrations")
FIRST_RUN_DELAY_SECONDS = 30


async def _loop(adapter: SourceAdapter) -> None:
    await asyncio.sleep(FIRST_RUN_DELAY_SECONDS)
    while True:
        try:
            await execute(SYNC_NOW, SYSTEM, SyncNow(source=adapter.name))
        except Exception:
            logger.exception("sync loop run failed", extra={"context": {"source": adapter.name}})
        await asyncio.sleep(adapter.interval_seconds)


@asynccontextmanager
async def sync_loops(_app: Any) -> AsyncIterator[None]:
    """Start a loop per configured source; cancel them on shutdown."""
    tasks = [asyncio.create_task(_loop(adapter)) for adapter in configured_adapters(get_settings()).values()]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task


api = FeatureApi(name="integrations", operations=OPERATIONS, lifespan=sync_loops)
```

In `backend/app/main.py`, add `from app.features.integrations.integrations import api as integrations` and set:

```python
FEATURES: tuple[FeatureApi, ...] = (profile, catalog, journal, integrations)
```

Also add one test to `test_runner.py` that the loops start and stop cleanly:

```python
async def test_sync_loops_start_and_stop(fake):
    from app.features.integrations.integrations import sync_loops

    async with sync_loops(None):
        pass
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (integrations: `4` + `5` = `9 passed`)

- [ ] **Step 6: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(integrations): adapter runner with source-authoritative sync and the gym-bro adapter

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 14: Days, part 1: models and pure calculations

**Files:**
- Create: `backend/app/features/days/__init__.py` (empty), `backend/app/features/days/models.py`, `backend/app/features/days/calculations.py`
- Test: `backend/tests/features/days/__init__.py` (empty), `backend/tests/features/days/test_calculations.py`

**Interfaces:**
- Consumes: `EventOut` (Task 11), `ProfileOut` and `SourcePreferenceOut` (Task 8),
  `SyncStatusOut` (Task 13), `Nutrients` (Task 2).
- Produces:
  - Models `Gauge(name, value, target, ratio)`,
    `EnergyOut(bmr, baseline, steps_kcal, workouts_kcal, maintenance)`,
    `TargetsOut(kcal, protein_g, carbs_g, fat_g, adjustment_kcal, missing, warnings)`,
    `SleepSummary(hours, quality, stages)`, `StepsSummary(steps, source)`,
    `WorkoutSummary(count, minutes)`, `SymptomSummary(type, count, max_severity)`,
    `DaySummary(day, nutrients, fluid_ml, sleep, steps, weight_kg, workouts, symptoms, outtake_count, energy, targets, gauges)`,
    `DayView(summary, timeline)`, `WeightInfo(latest_kg, latest_day, trend_kg_per_week)`,
    `ContextOut(today, day, weight, recent_symptoms, integrations, warnings)`,
    `DiaryDay(day, events)`, `Diary(days, next_cursor)`,
    `ProfileView(profile, targets_today, source_preferences, integrations)`, and the inputs
    `ContextQuery(date?)`, `DayQuery(date)` and `DiaryQuery(cursor?, days=7, kinds?)`
  - Calculations `age_on`, `bmr`, `energy`, `targets`, `gauges`, `pick_steps`,
    `workout_loads`, `sleep_summary`, `symptom_summary`, `summarize`, `weight_trend`,
    `context_warnings`, and `WorkoutLoad`

Constants, from spec §4.4: activity factor 1.2; steps 0.0004 kcal per step per kg; MET 7.0
for cardio and 5.0 otherwise; 7700 kcal per kg of body weight; adjustment clamp ±750
kcal/day; fat is at least max(fat_g_per_kg_min × weight, 25 % of kcal)/9; carbs are the
rest / 4, floored at 0.

- [ ] **Step 1: Write the failing tests**

`backend/tests/features/days/test_calculations.py`:

```python
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from app.features.days.calculations import (
    WorkoutLoad,
    age_on,
    context_warnings,
    energy,
    gauges,
    pick_steps,
    summarize,
    targets,
    weight_trend,
)
from app.features.journal.models import EventOut
from app.features.profile.models import ProfileOut
from app.helpers.models import Nutrients

DAY = date(2026, 9, 30)


def profile(**overrides) -> ProfileOut:
    values = {
        "id": uuid.uuid4(),
        "valid_from": datetime(2026, 9, 1, tzinfo=UTC),
        "timezone": "Europe/Berlin",
        "height_cm": 180,
        "birth_date": date(2001, 7, 29),
        "sex": "male",
        "goal_weight_kg": None,
        "goal_date": None,
        "protein_g_per_kg": 1.8,
        "fat_g_per_kg_min": 0.8,
        "gym_sessions_per_week": 3.5,
    }
    return ProfileOut(**(values | overrides))


def ev(kind: str, payload: dict, at: str = "2026-09-30T08:00:00+00:00", ends: str | None = None, source: str = "app", recorded: int = 0) -> EventOut:
    moment = datetime.fromisoformat(at)
    return EventOut(
        id=uuid.uuid4(),
        chain_id=uuid.uuid4(),
        version=1,
        kind=kind,
        occurred_at=moment,
        ends_at=datetime.fromisoformat(ends) if ends else None,
        local_day=DAY,
        payload=payload,
        source=source,
        recorded_at=datetime(2026, 9, 30, tzinfo=UTC) + timedelta(minutes=recorded),
        retracted=False,
    )


def test_age_counts_birthdays():
    assert age_on(date(2001, 7, 29), DAY) == 25
    assert age_on(date(2001, 12, 1), DAY) == 24


def test_energy_adds_steps_and_workouts_to_the_baseline():
    result = energy(84.3, 180, 25, "male", 8000, [WorkoutLoad(minutes=31, category="strength")])
    assert (result.bmr, result.baseline) == (1848.0, 2217.6)
    assert (result.steps_kcal, result.workouts_kcal) == (269.8, 174.2)
    assert result.maintenance == pytest.approx(2661.6)
    cardio = energy(84.3, 180, 25, "male", 0, [WorkoutLoad(minutes=60, category="cardio")])
    assert cardio.workouts_kcal == pytest.approx(505.8)


def test_energy_without_body_data_has_no_maintenance():
    assert energy(84.3, None, 25, "male", 1000, []).maintenance is None
    assert energy(None, 180, 25, "male", 1000, []).steps_kcal == 0


def test_targets_move_toward_the_goal():
    base = energy(84.3, 180, 25, "male", 0, [])
    result = targets(profile(goal_weight_kg=77, goal_date=date(2027, 1, 1)), 84.3, DAY, base)
    assert (result.adjustment_kcal, result.kcal, result.protein_g, result.fat_g) == (-604, 1614, 151.7, 67.4)
    assert result.carbs_g == pytest.approx(100.15, abs=0.06)
    assert result.warnings == []


def test_targets_clamp_an_impossible_pace_and_say_so():
    base = energy(84.3, 180, 25, "male", 0, [])
    result = targets(profile(goal_weight_kg=77, goal_date=date(2026, 10, 30)), 84.3, DAY, base)
    assert result.adjustment_kcal == -750
    assert result.warnings == ["goal date not reachable at a safe pace; capped at 750 kcal/day"]


def test_no_adjustment_without_a_future_goal():
    base = energy(84.3, 180, 25, "male", 0, [])
    assert targets(profile(), 84.3, DAY, base).adjustment_kcal == 0
    assert targets(profile(goal_weight_kg=77, goal_date=DAY), 84.3, DAY, base).adjustment_kcal == 0


def test_fat_floor_uses_the_larger_of_body_weight_and_calorie_share():
    base = energy(84.3, 180, 25, "male", 20000, [WorkoutLoad(minutes=120, category="cardio")])
    result = targets(profile(fat_g_per_kg_min=0.5), 84.3, DAY, base)
    assert result.fat_g == round(0.25 * result.kcal / 9, 1)


def test_targets_name_what_is_missing():
    base = energy(None, None, None, None, 0, [])
    assert targets(None, None, DAY, base).missing == ["profile", "weight_kg"]
    no_birth = targets(profile(birth_date=None), 84.3, DAY, energy(84.3, 180, None, "male", 0, []))
    assert (no_birth.missing, no_birth.kcal) == (["birth_date"], None)


def test_gauges_compare_intake_with_targets():
    base = energy(84.3, 180, 25, "male", 0, [])
    target = targets(profile(), 84.3, DAY, base)
    result = {g.name: g for g in gauges(Nutrients(kcal=target.kcal / 2, protein_g=10), target)}
    assert result["kcal"].ratio == 0.5
    assert set(result) == {"kcal", "protein", "carbs", "fat"}
    empty = gauges(Nutrients(), targets(None, None, DAY, base))
    assert all(g.ratio is None for g in empty)


def test_steps_follow_the_source_preference_then_recency():
    phone = ev("activity", {"steps": 6000}, source="app", recorded=5)
    ring = ev("activity", {"steps": 8421}, source="ring", recorded=1)
    assert pick_steps([phone, ring], ["ring", "app"]).source == "ring"
    assert pick_steps([phone, ring], []).steps == 6000
    assert pick_steps([ev("note", {"text": "x"})], []) is None


def test_summarize_builds_the_whole_day():
    events = [
        ev("intake", {"nutrients": {"kcal": 400, "protein_g": 30, "fluid_ml": 0}}),
        ev("intake", {"nutrients": {"kcal": 0, "fluid_ml": 500}}),
        ev("symptom", {"type": "bloated", "severity": 2}),
        ev("symptom", {"type": "bloated", "severity": 4}),
        ev("outtake", {"bristol": 4}),
        ev("workout", {"category": "strength", "title": "Push"}, at="2026-09-30T17:00:00+00:00", ends="2026-09-30T17:30:00+00:00"),
    ]
    sleep = ev("sleep", {"quality": 4}, at="2026-09-29T22:00:00+00:00", ends="2026-09-30T06:00:00+00:00")
    summary = summarize(DAY, events, sleep, 84.3, profile(), [])
    assert (summary.nutrients.kcal, summary.fluid_ml) == (400, 500)
    assert [(s.type, s.count, s.max_severity) for s in summary.symptoms] == [("bloated", 2, 4)]
    assert (summary.outtake_count, summary.workouts.count, summary.workouts.minutes) == (1, 1, 30)
    assert (summary.sleep.hours, summary.sleep.quality) == (8.0, 4)
    assert summary.energy.workouts_kcal > 0
    assert [g.name for g in summary.gauges] == ["kcal", "protein", "carbs", "fat"]


def test_weight_trend_is_the_slope_per_week():
    assert weight_trend([(date(2026, 9, 28), 85.5), (date(2026, 9, 29), 84.3)]) == -8.4
    assert weight_trend([(DAY, 84.0)]) is None
    assert weight_trend([]) is None


def test_context_warnings():
    summary = summarize(DAY, [], None, None, None, [])
    at_three = datetime(2026, 9, 30, 15, 0, tzinfo=UTC)
    warnings = context_warnings(
        today=DAY, day=DAY, local_now=at_three, summary=summary, timeline=[], latest_weight_day=None,
        integration_errors=[("gym-bro", "gym-bro did not answer")],
    )
    assert warnings == [
        "no weight logged in the last 7 days",
        "no intake logged today yet",
        "targets need: profile, weight_kg",
        "gym-bro sync failing: gym-bro did not answer",
    ]
    morning = context_warnings(
        today=DAY, day=DAY, local_now=at_three.replace(hour=9), summary=summary, timeline=[],
        latest_weight_day=DAY, integration_errors=[],
    )
    assert morning == ["targets need: profile, weight_kg"]
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/days/test_calculations.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.features.days'`

- [ ] **Step 3: Implement**

`backend/app/features/days/models.py`:

```python
"""Models only the days feature defines: summaries, views and their inputs."""

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.features.integrations.models import SyncStatusOut
from app.features.journal.models import EventOut
from app.features.journal.payloads import Kind
from app.features.profile.models import ProfileOut, SourcePreferenceOut
from app.helpers.models import Nutrients, QueryInput


class Gauge(BaseModel):
    """One of the four gauges: value against target."""

    name: Literal["kcal", "protein", "carbs", "fat"]
    value: float
    target: float | None
    ratio: float | None


class EnergyOut(BaseModel):
    """Estimated calories out; maintenance is null when body data is missing."""

    bmr: float | None
    baseline: float | None
    steps_kcal: float
    workouts_kcal: float
    maintenance: float | None


class TargetsOut(BaseModel):
    """The day's targets; null values name their missing inputs."""

    kcal: float | None = None
    protein_g: float | None = None
    carbs_g: float | None = None
    fat_g: float | None = None
    adjustment_kcal: float | None = None
    missing: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class SleepSummary(BaseModel):
    """The sleep that ended on this day."""

    hours: float
    quality: int | None
    stages: dict[str, Any] | None


class StepsSummary(BaseModel):
    """Steps from the preferred source."""

    steps: int
    source: str


class WorkoutSummary(BaseModel):
    """Workouts on this day."""

    count: int
    minutes: float


class SymptomSummary(BaseModel):
    """One symptom type on this day."""

    type: str
    count: int
    max_severity: int


class DaySummary(BaseModel):
    """Everything computed for one local day."""

    day: date
    nutrients: Nutrients
    fluid_ml: float
    sleep: SleepSummary | None
    steps: StepsSummary | None
    weight_kg: float | None
    workouts: WorkoutSummary
    symptoms: list[SymptomSummary]
    outtake_count: int
    energy: EnergyOut
    targets: TargetsOut
    gauges: list[Gauge]


class DayView(BaseModel):
    """A day's summary and its timeline."""

    summary: DaySummary
    timeline: list[EventOut]


class WeightInfo(BaseModel):
    """The latest weight and the 14-day trend."""

    latest_kg: float | None
    latest_day: date | None
    trend_kg_per_week: float | None


class ContextOut(BaseModel):
    """Everything Claude needs at the start of a conversation."""

    today: date
    day: DayView
    weight: WeightInfo
    recent_symptoms: list[EventOut]
    integrations: list[SyncStatusOut]
    warnings: list[str]


class DiaryDay(BaseModel):
    """One day of the diary."""

    day: date
    events: list[EventOut]


class Diary(BaseModel):
    """Whole days, newest first; pass next_cursor to continue."""

    days: list[DiaryDay]
    next_cursor: str | None


class ProfileView(BaseModel):
    """The profile screen."""

    profile: ProfileOut | None
    targets_today: TargetsOut
    source_preferences: list[SourcePreferenceOut]
    integrations: list[SyncStatusOut]


class ContextQuery(QueryInput):
    """Defaults to the owner's today."""

    date: date | None = None


class DayQuery(QueryInput):
    """One local day."""

    date: date


class DiaryQuery(QueryInput):
    """A page of whole days."""

    cursor: str | None = None
    days: int = Field(default=7, ge=1, le=31)
    kinds: list[Kind] | None = None
```

`backend/app/features/days/calculations.py`:

```python
"""Pure maths for a day: energy, targets, summary, gauges, weight trend and warnings."""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime

from app.features.days.models import (
    DaySummary,
    EnergyOut,
    Gauge,
    SleepSummary,
    StepsSummary,
    SymptomSummary,
    TargetsOut,
    WorkoutSummary,
)
from app.features.journal.models import EventOut
from app.features.profile.models import ProfileOut
from app.helpers.models import Nutrients

ACTIVITY_FACTOR = 1.2
STEP_KCAL_PER_KG = 0.0004
MET_CARDIO = 7.0
MET_OTHER = 5.0
KCAL_PER_KG_BODY = 7700
MAX_ADJUSTMENT_KCAL = 750
FAT_SHARE_MIN = 0.25


@dataclass(frozen=True)
class WorkoutLoad:
    """A workout's duration and category, for the energy estimate."""

    minutes: float
    category: str


def age_on(birth: date, day: date) -> int:
    """Full years on a day."""
    return day.year - birth.year - ((day.month, day.day) < (birth.month, birth.day))


def bmr(weight_kg: float, height_cm: float, age: int, sex: str) -> float:
    """Mifflin-St Jeor basal metabolic rate."""
    return 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 if sex == "male" else -161)


def energy(
    weight_kg: float | None,
    height_cm: float | None,
    age: int | None,
    sex: str | None,
    steps: int,
    workouts: Sequence[WorkoutLoad],
) -> EnergyOut:
    """Calories out: baseline (BMR x 1.2) plus steps plus workouts."""
    steps_kcal = round(steps * weight_kg * STEP_KCAL_PER_KG, 1) if weight_kg else 0.0
    workouts_kcal = (
        round(
            sum(((MET_CARDIO if w.category == "cardio" else MET_OTHER) - 1) * weight_kg * w.minutes / 60 for w in workouts),
            1,
        )
        if weight_kg
        else 0.0
    )
    if weight_kg is None or height_cm is None or age is None or sex is None:
        return EnergyOut(bmr=None, baseline=None, steps_kcal=steps_kcal, workouts_kcal=workouts_kcal, maintenance=None)
    base = bmr(weight_kg, height_cm, age, sex)
    baseline = base * ACTIVITY_FACTOR
    return EnergyOut(
        bmr=round(base, 1),
        baseline=round(baseline, 1),
        steps_kcal=steps_kcal,
        workouts_kcal=workouts_kcal,
        maintenance=round(baseline + steps_kcal + workouts_kcal, 1),
    )


def _adjustment(profile: ProfileOut, weight_kg: float, day: date) -> tuple[float, list[str]]:
    goal, goal_date = profile.goal_weight_kg, profile.goal_date
    if goal is None or goal_date is None or day >= goal_date:
        return 0, []
    difference = goal - weight_kg
    if abs(difference) < 0.05:
        return 0, []
    raw = difference * KCAL_PER_KG_BODY / (goal_date - day).days
    if abs(raw) > MAX_ADJUSTMENT_KCAL:
        warning = f"goal date not reachable at a safe pace; capped at {MAX_ADJUSTMENT_KCAL} kcal/day"
        return math.copysign(MAX_ADJUSTMENT_KCAL, raw), [warning]
    return round(raw), []


def targets(profile: ProfileOut | None, weight_kg: float | None, day: date, energy_out: EnergyOut) -> TargetsOut:
    """kcal, protein, carbs and fat for a day; null values name the missing inputs."""
    missing = ["profile"] if profile is None else [f for f in ("height_cm", "birth_date", "sex") if getattr(profile, f) is None]
    if weight_kg is None:
        missing.append("weight_kg")
    if missing or profile is None or weight_kg is None or energy_out.maintenance is None:
        return TargetsOut(missing=missing)
    adjustment, warnings = _adjustment(profile, weight_kg, day)
    kcal = round(energy_out.maintenance + adjustment)
    protein = round(profile.protein_g_per_kg * weight_kg, 1)
    fat = round(max(profile.fat_g_per_kg_min * weight_kg, FAT_SHARE_MIN * kcal / 9), 1)
    carbs = round(max(0.0, (kcal - protein * 4 - fat * 9) / 4), 1)
    return TargetsOut(kcal=kcal, protein_g=protein, carbs_g=carbs, fat_g=fat, adjustment_kcal=adjustment, warnings=warnings)


def gauges(nutrients: Nutrients, target: TargetsOut) -> list[Gauge]:
    """The four gauges, in display order."""
    pairs = (
        ("kcal", nutrients.kcal, target.kcal),
        ("protein", nutrients.protein_g, target.protein_g),
        ("carbs", nutrients.carbs_g, target.carbs_g),
        ("fat", nutrients.fat_g, target.fat_g),
    )
    return [
        Gauge(name=name, value=round(value, 1), target=goal, ratio=round(value / goal, 3) if goal else None)
        for name, value, goal in pairs
    ]


def pick_steps(events: Sequence[EventOut], preference: Sequence[str]) -> StepsSummary | None:
    """Steps from the most preferred source; among equals, the latest recorded."""
    candidates = [e for e in events if e.kind == "activity" and e.payload.get("steps") is not None]
    if not candidates:
        return None

    def rank(event: EventOut) -> tuple[int, float]:
        position = preference.index(event.source) if event.source in preference else len(preference)
        return position, -event.recorded_at.timestamp()

    best = min(candidates, key=rank)
    return StepsSummary(steps=best.payload["steps"], source=best.source)


def workout_loads(events: Sequence[EventOut]) -> list[WorkoutLoad]:
    """Duration and category of each workout."""
    return [
        WorkoutLoad(
            minutes=(e.ends_at - e.occurred_at).total_seconds() / 60 if e.ends_at else 0,
            category=e.payload.get("category", "other"),
        )
        for e in events
        if e.kind == "workout"
    ]


def sleep_summary(sleep: EventOut | None) -> SleepSummary | None:
    """Hours, quality and stages of a sleep event."""
    if sleep is None or sleep.ends_at is None:
        return None
    hours = round((sleep.ends_at - sleep.occurred_at).total_seconds() / 3600, 2)
    return SleepSummary(hours=hours, quality=sleep.payload.get("quality"), stages=sleep.payload.get("stages"))


def symptom_summary(events: Sequence[EventOut]) -> list[SymptomSummary]:
    """Count and worst severity per symptom type, by type."""
    grouped: dict[str, list[int]] = {}
    for event in events:
        if event.kind == "symptom":
            grouped.setdefault(event.payload["type"], []).append(event.payload["severity"])
    return [SymptomSummary(type=t, count=len(s), max_severity=max(s)) for t, s in sorted(grouped.items())]


def summarize(
    day: date,
    events: Sequence[EventOut],
    sleep: EventOut | None,
    weight_kg: float | None,
    profile: ProfileOut | None,
    step_preference: Sequence[str],
) -> DaySummary:
    """The whole day from its events, the night's sleep, the weight and the profile."""
    steps = pick_steps(events, step_preference)
    loads = workout_loads(events)
    age = age_on(profile.birth_date, day) if profile and profile.birth_date else None
    energy_out = energy(
        weight_kg,
        profile.height_cm if profile else None,
        age,
        profile.sex if profile else None,
        steps.steps if steps else 0,
        loads,
    )
    target = targets(profile, weight_kg, day, energy_out)
    nutrients = Nutrients.total(Nutrients.model_validate(e.payload["nutrients"]) for e in events if e.kind == "intake")
    return DaySummary(
        day=day,
        nutrients=nutrients,
        fluid_ml=nutrients.fluid_ml,
        sleep=sleep_summary(sleep),
        steps=steps,
        weight_kg=weight_kg,
        workouts=WorkoutSummary(count=len(loads), minutes=round(sum(w.minutes for w in loads), 1)),
        symptoms=symptom_summary(events),
        outtake_count=sum(1 for e in events if e.kind == "outtake"),
        energy=energy_out,
        targets=target,
        gauges=gauges(nutrients, target),
    )


def weight_trend(points: Sequence[tuple[date, float]]) -> float | None:
    """Least-squares slope in kg per week; None with fewer than two distinct days."""
    if len({d for d, _ in points}) < 2:
        return None
    origin = min(d for d, _ in points)
    xs = [(d - origin).days for d, _ in points]
    ys = [v for _, v in points]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys, strict=True)) / sum((x - mean_x) ** 2 for x in xs)
    return round(slope * 7, 2)


def context_warnings(
    *,
    today: date,
    day: date,
    local_now: datetime,
    summary: DaySummary,
    timeline: Sequence[EventOut],
    latest_weight_day: date | None,
    integration_errors: Sequence[tuple[str, str]],
) -> list[str]:
    """Things worth saying at the start of a conversation."""
    warnings = []
    if latest_weight_day is None or (day - latest_weight_day).days > 7:
        warnings.append("no weight logged in the last 7 days")
    if day == today and local_now.hour >= 14 and not any(e.kind == "intake" for e in timeline):
        warnings.append("no intake logged today yet")
    if summary.targets.missing:
        warnings.append("targets need: " + ", ".join(summary.targets.missing))
    warnings.extend(summary.targets.warnings)
    warnings.extend(f"{source} sync failing: {error}" for source, error in integration_errors)
    return warnings
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/features/days/test_calculations.py -q`
Expected: `13 passed`

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(days): day summary, energy, goal-driven targets, gauges and weight trend

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Days, part 2: context, day, diary and profile views

**Files:**
- Create: `backend/app/features/days/exceptions.py`, `backend/app/features/days/functions.py`, `backend/app/features/days/routers.py`, `backend/app/features/days/days.py`
- Modify: `backend/app/main.py` (add the API to `FEATURES`)
- Test: `backend/tests/features/days/test_views.py`

**Interfaces:**
- Consumes: Tasks 8, 11–14.
- Produces:
  - Queries `get_context` (view `today`), `get_day` (view `day`), `get_diary` (view
    `diary`) and `get_profile` (view `profile`)
  - the exception `InvalidCursor`
  - `days.api`

- [ ] **Step 1: Write the failing tests**

`backend/tests/features/days/test_views.py`:

```python
from app.features.profile.functions import timezone_at
from app.helpers.config import get_settings
from app.helpers.time import local_day, utcnow
from tests.clients import call_tool
from tests.conftest import requires_db
from tests.features.journal.helpers import draft, food, logged

pytestmark = requires_db


async def _owner(rest):
    await rest.post(
        "/api/v2/commands/update_profile",
        json={"height_cm": 180, "birth_date": "2001-04-02", "sex": "male", "goal_weight_kg": 77, "goal_date": "2027-01-01"},
    )


async def test_day_view_sums_the_day_and_counts_last_nights_sleep(rest):
    await _owner(rest)
    skyr = await food(rest)
    await logged(
        rest,
        draft("measurement", {"metric": "weight_kg", "value": 84.3}, occurred_at="2026-09-30T07:00:00+02:00"),
        draft("intake", {"items": [{"food_id": skyr["id"], "grams": 500}]}, occurred_at="2026-09-30T08:00:00+02:00"),
        draft("sleep", {"quality": 4}, occurred_at="2026-09-29T22:30:00+02:00", ends_at="2026-09-30T06:30:00+02:00"),
        draft("activity", {"steps": 8000}, occurred_at="2026-09-30T00:00:00+02:00", ends_at="2026-10-01T00:00:00+02:00"),
    )
    view = (await rest.get("/api/v2/views/day", params={"date": "2026-09-30"})).json()
    summary = view["summary"]
    assert summary["nutrients"]["kcal"] == 310
    assert summary["sleep"]["hours"] == 8.0
    assert summary["steps"] == {"steps": 8000, "source": "app"}
    assert summary["weight_kg"] == 84.3
    assert summary["targets"]["kcal"] is not None
    assert [g["name"] for g in summary["gauges"]] == ["kcal", "protein", "carbs", "fat"]
    assert "sleep" not in [e["kind"] for e in view["timeline"]]


async def test_context_for_claude(mcp, rest):
    await _owner(rest)
    await logged(
        rest,
        draft("measurement", {"metric": "weight_kg", "value": 85.5}, occurred_at="2026-09-28T07:00:00+02:00"),
        draft("measurement", {"metric": "weight_kg", "value": 84.3}, occurred_at="2026-09-29T07:00:00+02:00"),
        draft("symptom", {"type": "gas", "severity": 2}, occurred_at="2026-09-29T20:00:00+02:00"),
    )
    async with mcp() as client:
        context = await call_tool(client, "get_context", {"date": "2026-09-30"})
    assert context["weight"] == {"latest_kg": 84.3, "latest_day": "2026-09-29", "trend_kg_per_week": -8.4}
    assert [e["payload"]["type"] for e in context["recent_symptoms"]] == ["gas"]
    assert context["day"]["summary"]["day"] == "2026-09-30"
    assert isinstance(context["warnings"], list)


async def test_context_defaults_to_the_owners_today(rest, db):
    body = (await rest.get("/api/v2/views/today")).json()
    now = utcnow()
    expected = local_day(now, await timezone_at(db, now, get_settings().default_timezone))
    assert body["today"] == expected.isoformat()
    assert "targets need: profile, weight_kg" in body["warnings"]


async def test_diary_pages_whole_days(rest):
    await logged(
        rest,
        draft("note", {"text": "a"}, occurred_at="2026-09-20T10:00:00Z"),
        draft("note", {"text": "b"}, occurred_at="2026-09-25T09:00:00Z"),
        draft("checkin", {"overall": 3}, occurred_at="2026-09-25T20:00:00Z"),
        draft("note", {"text": "c"}, occurred_at="2026-09-27T10:00:00Z"),
    )
    first = (await rest.get("/api/v2/views/diary", params={"days": 2})).json()
    assert [d["day"] for d in first["days"]] == ["2026-09-27", "2026-09-25"]
    assert [e["kind"] for e in first["days"][1]["events"]] == ["note", "checkin"]
    second = (await rest.get("/api/v2/views/diary", params={"days": 2, "cursor": first["next_cursor"]})).json()
    assert ([d["day"] for d in second["days"]], second["next_cursor"]) == (["2026-09-20"], None)
    filtered = (await rest.get("/api/v2/views/diary", params={"kinds": ["checkin"]})).json()
    assert [d["day"] for d in filtered["days"]] == ["2026-09-25"]
    bad = await rest.get("/api/v2/views/diary", params={"cursor": "e30="})
    assert (bad.status_code, bad.json()["field"]) == (422, "cursor")


async def test_profile_view(rest):
    empty = (await rest.get("/api/v2/views/profile")).json()
    assert empty["profile"] is None
    assert empty["targets_today"]["missing"] == ["profile", "weight_kg"]
    await _owner(rest)
    await rest.post("/api/v2/commands/set_source_preference", json={"metric": "steps", "sources": ["ring", "app"]})
    view = (await rest.get("/api/v2/views/profile")).json()
    assert view["profile"]["height_cm"] == 180
    assert view["source_preferences"] == [{"metric": "steps", "sources": ["ring", "app"]}]
    assert view["integrations"] == []

```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && uv run pytest tests/features/days/test_views.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.features.days.functions'`

- [ ] **Step 3: Implement**

`backend/app/features/days/exceptions.py`:

```python
"""Every error the days feature raises."""

from app.helpers.errors import ValidationFailed


class InvalidCursor(ValidationFailed):
    def __init__(self) -> None:
        super().__init__("invalid cursor", "cursor")
```

`backend/app/features/days/functions.py`:

```python
"""Composing days: load events, profile, weight and sync status, then summarise."""

from datetime import date, timedelta

from app.features.days.calculations import context_warnings, summarize, weight_trend
from app.features.days.exceptions import InvalidCursor
from app.features.days.models import (
    ContextOut,
    ContextQuery,
    DayQuery,
    DayView,
    Diary,
    DiaryDay,
    DiaryQuery,
    ProfileView,
    WeightInfo,
)
from app.features.integrations.functions import sync_status
from app.features.journal.functions import days_with_events, heads_between, latest_measurement, measurements
from app.features.profile.functions import current_profile, list_source_preferences, preferred_sources, profile_for, timezone_at
from app.features.profile.models import ProfileOut
from app.helpers.endpoints import Context
from app.helpers.errors import ValidationFailed
from app.helpers.models import EmptyQuery, decode_cursor, encode_cursor
from app.helpers.time import day_bounds, local_day, to_local

TREND_DAYS = 14
RECENT_SYMPTOM_DAYS = 3


async def _today(ctx: Context) -> tuple[date, str]:
    timezone = await timezone_at(ctx.session, ctx.now, ctx.settings.default_timezone)
    return local_day(ctx.now, timezone), timezone


async def _day_view(ctx: Context, day: date) -> DayView:
    """A day's events, plus the sleep that ended on it (it started the evening before)."""
    events = await heads_between(ctx.session, day - timedelta(days=1), day)
    timeline = [e for e in events if e.local_day == day]
    sleeps = []
    for event in events:
        if event.kind == "sleep" and event.ends_at is not None:
            timezone = await timezone_at(ctx.session, event.ends_at, ctx.settings.default_timezone)
            if local_day(event.ends_at, timezone) == day:
                sleeps.append(event)
    sleep = max(sleeps, key=lambda e: e.ends_at - e.occurred_at, default=None)
    timezone = await timezone_at(ctx.session, ctx.now, ctx.settings.default_timezone)
    end_of_day = day_bounds(day, timezone)[1] - timedelta(microseconds=1)
    profile_row = await profile_for(ctx.session, end_of_day)
    profile = ProfileOut.model_validate(profile_row) if profile_row else None
    weight = await latest_measurement(ctx.session, "weight_kg", day)
    preference = (await preferred_sources(ctx.session)).get("steps", [])
    summary = summarize(day, timeline, sleep, weight.payload["value"] if weight else None, profile, preference)
    return DayView(summary=summary, timeline=timeline)


async def get_day(ctx: Context, data: DayQuery) -> DayView:
    """One local day: summary with the four gauges, and its timeline."""
    return await _day_view(ctx, data.date)


async def get_context(ctx: Context, data: ContextQuery) -> ContextOut:
    """The whole picture for a day (default today) in one call."""
    today, timezone = await _today(ctx)
    day = data.date or today
    view = await _day_view(ctx, day)
    latest = await latest_measurement(ctx.session, "weight_kg", day)
    series = await measurements(ctx.session, "weight_kg", day - timedelta(days=TREND_DAYS - 1), day)
    weight = WeightInfo(
        latest_kg=latest.payload["value"] if latest else None,
        latest_day=latest.local_day if latest else None,
        trend_kg_per_week=weight_trend([(e.local_day, e.payload["value"]) for e in series]),
    )
    symptoms = await heads_between(ctx.session, day - timedelta(days=RECENT_SYMPTOM_DAYS - 1), day, ["symptom"])
    integrations = await sync_status(ctx.session, ctx.settings)
    warnings = context_warnings(
        today=today,
        day=day,
        local_now=to_local(ctx.now, timezone),
        summary=view.summary,
        timeline=view.timeline,
        latest_weight_day=weight.latest_day,
        integration_errors=[(s.source, s.last_error) for s in integrations if s.last_error],
    )
    return ContextOut(today=today, day=view, weight=weight, recent_symptoms=symptoms, integrations=integrations, warnings=warnings)


def _before(cursor: str | None) -> date | None:
    if cursor is None:
        return None
    try:
        return date.fromisoformat(decode_cursor(cursor)["before"])
    except (ValidationFailed, KeyError, TypeError, ValueError) as exc:
        raise InvalidCursor() from exc


async def get_diary(ctx: Context, data: DiaryQuery) -> Diary:
    """Whole days with events, newest first; events within a day in time order."""
    days = await days_with_events(ctx.session, _before(data.cursor), data.days, data.kinds)
    if not days:
        return Diary(days=[], next_cursor=None)
    events = await heads_between(ctx.session, days[-1], days[0], data.kinds)
    grouped: dict[date, list] = {day: [] for day in days}
    for event in events:
        if event.local_day in grouped:
            grouped[event.local_day].append(event)
    next_cursor = encode_cursor({"before": days[-1].isoformat()}) if len(days) == data.days else None
    return Diary(days=[DiaryDay(day=day, events=grouped[day]) for day in days], next_cursor=next_cursor)


async def get_profile(ctx: Context, data: EmptyQuery) -> ProfileView:
    """The profile with today's targets, source preferences and integration status."""
    today, _ = await _today(ctx)
    view = await _day_view(ctx, today)
    return ProfileView(
        profile=await current_profile(ctx.session, ctx.now),
        targets_today=view.summary.targets,
        source_preferences=await list_source_preferences(ctx.session),
        integrations=await sync_status(ctx.session, ctx.settings),
    )
```

`backend/app/features/days/routers.py`:

```python
"""The days feature's endpoints."""

from app.features.days import functions
from app.features.days.exceptions import InvalidCursor
from app.features.days.models import ContextOut, ContextQuery, DayQuery, DayView, Diary, DiaryQuery, ProfileView
from app.helpers.endpoints import query
from app.helpers.models import EmptyQuery

OPERATIONS = (
    query(
        "get_context",
        ContextQuery,
        ContextOut,
        functions.get_context,
        "START HERE in every conversation. The owner's day (default today): summary with the four "
        "gauges (kcal, protein, carbs, fat vs targets), timeline, latest weight and 14-day trend, "
        "symptoms of the last 3 days, sync status and warnings.",
        view="today",
    ),
    query("get_day", DayQuery, DayView, functions.get_day, "One local day: summary with gauges, and its timeline.", view="day"),
    query(
        "get_diary",
        DiaryQuery,
        Diary,
        functions.get_diary,
        "Whole days with events, newest first; pass next_cursor for older days.",
        errors=(InvalidCursor,),
        view="diary",
    ),
    query(
        "get_profile",
        EmptyQuery,
        ProfileView,
        functions.get_profile,
        "The profile, today's targets, source preferences and integration status.",
        view="profile",
    ),
)
```

`backend/app/features/days/days.py`:

```python
"""The days feature's API."""

from app.features.days.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(name="days", operations=OPERATIONS)
```

In `backend/app/main.py`, add `from app.features.days.days import api as days` and set:

```python
FEATURES: tuple[FeatureApi, ...] = (profile, catalog, journal, integrations, days)
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest -q`
Expected: all pass (`test_views.py`: `5 passed`)

- [ ] **Step 5: Commit**

```bash
cd backend && uv run ruff format && uv run ruff check && cd ..
git add backend
git commit -m "feat(days): context, day, diary and profile views

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 16: Migration 0001 and contract tests

**Files:**
- Create: `backend/alembic.ini`, `backend/alembic/env.py`, `backend/alembic/script.py.mako`, `backend/alembic/versions/0001_core.py` (generated), `backend/tests/contracts/__init__.py` (empty), `backend/tests/contracts/test_operations.py`, `backend/tests/contracts/test_parity.py`
- Modify: `.github/workflows/ci.yml` (Postgres service, `TEST_DATABASE_URL`, migration check)

**Interfaces:**
- Consumes: everything above.
- Produces: the schema migration, and contract tests that fail when:
  - the MCP tool set drifts from the 24 in spec §7.1
  - a feature exception isn't declared on any operation
  - a declared error is missing from OpenAPI
  - REST and MCP disagree for any event kind

- [ ] **Step 1: Write the contract tests**

`backend/tests/contracts/test_operations.py`:

```python
import importlib
import inspect
import pkgutil

import app.features
from app.features.journal.payloads import KINDS
from app.helpers.endpoints import BASE_ERRORS, schemas_api
from app.helpers.errors import AppError
from app.main import FEATURES, create_app
from tests.clients import rpc
from tests.conftest import requires_db

TOOLS = {
    "update_profile", "set_source_preference",
    "import_food", "save_food", "archive_food", "save_recipe", "archive_recipe",
    "find_food", "get_food", "get_recipe", "list_recipes",
    "log_events", "correct_event", "retract_event", "link_events", "unlink_events",
    "query_events", "get_event_history",
    "sync_now",
    "get_context", "get_day", "get_diary", "get_profile",
    "get_schemas",
}
OPERATIONS = [op for api in FEATURES for op in api.operations]


@requires_db
async def test_mcp_exposes_exactly_the_contract_tools(mcp):
    async with mcp() as client:
        names = {tool["name"] for tool in (await rpc(client, "tools/list"))["tools"]}
    assert names == TOOLS
    assert len(TOOLS) == 24


def test_every_feature_exception_is_declared_on_an_operation():
    declared = {error for op in OPERATIONS for error in op.errors}
    for module in pkgutil.iter_modules(app.features.__path__):
        exceptions = importlib.import_module(f"app.features.{module.name}.exceptions")
        for obj in vars(exceptions).values():
            if inspect.isclass(obj) and issubclass(obj, AppError) and obj.__module__ == exceptions.__name__:
                assert obj in declared, f"{obj.__name__} is raised by {module.name} but declared on no operation"


def test_openapi_documents_every_declared_error():
    spec = create_app().openapi()
    for op in OPERATIONS:
        if op.rest is None:
            continue
        method, path = op.rest
        responses = spec["paths"][f"/api/v2{path}"][method.lower()]["responses"]
        for error in (*BASE_ERRORS, *op.errors):
            assert str(error.status) in responses, f"{op.name} does not document {error.code}"


def test_rest_shape_follows_the_kind():
    for op in OPERATIONS:
        if op.kind == "command":
            assert op.rest == ("POST", f"/commands/{op.name}")
        elif op.rest is not None:
            assert op.rest[0] == "GET"
    views = {op.view for op in OPERATIONS if op.view}
    assert views == {"today", "day", "diary", "event", "catalog", "food", "recipe", "recipes", "profile"}


def test_every_event_kind_publishes_its_schema():
    assert set(schemas_api(FEATURES).operations[0].output.model_fields) == {"commands", "queries", "payloads"}
    assert set(dict(next(api for api in FEATURES if api.name == "journal").schemas)) == set(KINDS)
```

`backend/tests/contracts/test_parity.py`:

```python
from typing import Any

from tests.clients import call_tool
from tests.conftest import requires_db
from tests.features.journal.helpers import food
from tests.features.journal.test_payloads import EXAMPLES

pytestmark = requires_db

DAY = "2026-09-30"
AT = "2026-09-30T08:00:00+02:00"
ENDS = {"sleep": "2026-09-30T09:00:00+02:00", "activity": "2026-10-01T00:00:00+02:00", "workout": "2026-09-30T09:00:00+02:00"}


def _drafts(food_id: str) -> list[dict[str, Any]]:
    drafts = []
    for kind, payload in EXAMPLES.items():
        if kind == "intake":
            payload = {"items": [{"food_id": food_id, "grams": 150}], "slot": "breakfast"}
        occurred = "2026-09-30T00:00:00+02:00" if kind == "activity" else AT
        draft = {"kind": kind, "occurred_at": occurred, "payload": payload}
        if kind in ENDS:
            draft["ends_at"] = ENDS[kind]
        drafts.append(draft)
    return drafts


def _comparable(view: dict[str, Any]) -> dict[str, Any]:
    timeline = [(e["kind"], e["occurred_at"], e["ends_at"], e["payload"]) for e in view["timeline"]]
    summary = dict(view["summary"])
    summary.pop("steps", None)
    return {"summary": summary, "timeline": sorted(timeline, key=repr)}


async def test_rest_and_mcp_produce_the_same_day_for_every_kind(rest, mcp):
    skyr = await food(rest)
    drafts = _drafts(skyr["id"])
    via_rest = (await rest.post("/api/v2/commands/log_events", json={"events": drafts})).json()["result"]["events"]
    rest_view = (await rest.get("/api/v2/views/day", params={"date": DAY})).json()
    for event in via_rest:
        await rest.post("/api/v2/commands/retract_event", json={"id": event["id"]})
    async with mcp() as client:
        via_mcp = (await call_tool(client, "log_events", {"events": drafts}))["result"]["events"]
        mcp_view = await call_tool(client, "get_day", {"date": DAY})
    assert {e["source"] for e in via_rest} == {"app"}
    assert {e["source"] for e in via_mcp} == {"claude"}
    assert _comparable(rest_view) == _comparable(mcp_view)
```

The `steps` summary carries the source name, which is `app` versus `claude` by design, so
the comparison leaves it out. Everything else must be identical.

- [ ] **Step 2: Run the contract tests**

Run: `cd backend && uv run pytest tests/contracts -q`
Expected: `6 passed`. If `test_every_feature_exception_is_declared_on_an_operation` fails,
add the missing error to the `errors=` of the operation that raises it. Never delete the
exception.

- [ ] **Step 3: Set up Alembic**

```bash
cd backend && uv run alembic init -t async alembic
```

Replace `backend/alembic/env.py` with:

```python
"""Alembic: migrations for every table the features declare (imported through app.main)."""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

import app.main  # noqa: F401
from app.helpers.config import get_settings
from app.helpers.database import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=get_settings().database_url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def _run(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(get_settings().database_url)
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
```

In `backend/alembic.ini`, delete the `sqlalchemy.url = ...` line, because the URL comes
from settings.

- [ ] **Step 4: Generate and verify migration 0001**

```bash
docker exec daily2-testdb createdb -U daily2 daily2_migrations
export DATABASE_URL=postgresql+psycopg://daily2:daily2@localhost:55433/daily2_migrations
uv run alembic revision --autogenerate -m core --rev-id 0001
ls alembic/versions/   # expect 0001_core.py (alembic's default file template is <rev>_<slug>)
```

Open `alembic/versions/0001_core.py` and check that it creates exactly these tables:
`command_log`, `profile_version`, `source_preference`, `food`, `food_version`, `recipe`,
`recipe_version`, `event`, `event_link` and `sync_state`. It must also create the indexes
`uq_event_chain_head` and `uq_event_external_head`, both with their `postgresql_where`,
and `ix_event_day_kind`. If an index lacks its `postgresql_where`, add it by hand.

Then verify the round trip:

```bash
uv run alembic upgrade head && uv run alembic check
uv run alembic downgrade base && uv run alembic upgrade head && uv run alembic check
```

Expected: the last line is `No new upgrade operations detected.`

- [ ] **Step 5: Extend CI with Postgres and the migration check**

Replace the `backend` job in `.github/workflows/ci.yml` with:

```yaml
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
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v7
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
```

Keep the action majors you chose in Task 0.

- [ ] **Step 6: Run everything and commit**

Run: `cd backend && uv run pytest -q && uv run ruff check && uv run ruff format --check`
Expected: every test passes and ruff is clean.

```bash
git add backend .github
git commit -m "feat: migration 0001 and contract tests for tools, errors and REST/MCP parity

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Container, dev stack, E2E scenario, CI and README

**Files:**
- Create: `backend/Dockerfile`, `backend/.dockerignore`, `backend/docker-entrypoint.sh`, `docker-compose.yml`, `keycloak/realm-dev.json`, `e2e/scenario.py`
- Modify: `.github/workflows/ci.yml` (add the `e2e` job), `README.md`

**Interfaces:**
- Consumes: the finished backend.
- Produces:
  - a production image (runs migrations, then uvicorn)
  - a local stack: `docker compose up -d --build --wait` starts Postgres on 55433,
    Keycloak on 18180 and the backend on 18100
  - `e2e/scenario.py`: the spec §11 scenario against the real stack, which exits 1 on the
    first failure

- [ ] **Step 1: Container**

`backend/Dockerfile`:

```dockerfile
FROM python:3.14-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH="/app/.venv/bin:$PATH"
WORKDIR /app
RUN useradd --uid 10001 --no-create-home daily2
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY alembic.ini docker-entrypoint.sh ./
COPY alembic ./alembic
COPY app ./app
RUN uv sync --frozen --no-dev && chmod +x docker-entrypoint.sh
USER daily2
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
ENTRYPOINT ["./docker-entrypoint.sh"]
```

`backend/.dockerignore`:

```
.venv
tests
**/__pycache__
.pytest_cache
.ruff_cache
.env
```

`backend/docker-entrypoint.sh`:

```sh
#!/bin/sh
set -e
alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers "${WORKERS:-2}" --proxy-headers --forwarded-allow-ips='*'
```

Migrations run once here, before the workers fork. Each worker runs its own sync loop, and
the advisory lock in `run_adapter` keeps concurrent runs from applying twice.

- [ ] **Step 2: Dev realm and compose**

`keycloak/realm-dev.json`. Every credential here is **dev-only**, belongs to a throwaway
local realm, and is never used anywhere else.

```json
{
  "realm": "daily2",
  "displayName": "daily2 (DEV ONLY - throwaway local realm)",
  "enabled": true,
  "sslRequired": "none",
  "users": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "username": "dev",
      "enabled": true,
      "emailVerified": true,
      "firstName": "Dev",
      "lastName": "Owner",
      "email": "dev@example.invalid",
      "credentials": [{ "type": "password", "value": "dev", "temporary": false }]
    }
  ],
  "clients": [
    {
      "clientId": "daily2-app",
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true,
      "redirectUris": ["http://localhost:4200/*", "http://localhost:18101/*"],
      "webOrigins": ["+"],
      "attributes": { "pkce.code.challenge.method": "S256" }
    },
    {
      "clientId": "daily2-mcp",
      "publicClient": false,
      "secret": "dev-mcp-secret",
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true,
      "redirectUris": ["https://claude.ai/*"],
      "protocolMappers": [
        {
          "name": "mcp-audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.custom.audience": "http://localhost:18100/mcp",
            "access.token.claim": "true",
            "id.token.claim": "false"
          }
        }
      ]
    },
    {
      "clientId": "daily2-gymbro-sync",
      "publicClient": false,
      "secret": "dev-sync-secret",
      "standardFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": true
    }
  ]
}
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: daily2
      POSTGRES_PASSWORD: daily2 # dev-only
      POSTGRES_DB: daily2
    ports: ["55433:5432"]
    volumes: [daily2_db:/var/lib/postgresql]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U daily2"]
      interval: 5s
      retries: 20

  keycloak:
    image: quay.io/keycloak/keycloak:26.6
    command: ["start-dev", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin # dev-only
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin # dev-only
      KC_HOSTNAME: http://localhost:18180
      KC_HEALTH_ENABLED: "true"
    volumes: [./keycloak:/opt/keycloak/data/import:ro]
    ports: ["18180:8080"]
    healthcheck:
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q UP <&3"]
      interval: 5s
      retries: 40
      start_period: 60s

  backend:
    build: ./backend
    depends_on:
      db: { condition: service_healthy }
      keycloak: { condition: service_healthy }
    environment:
      DATABASE_URL: postgresql+psycopg://daily2:daily2@db/daily2
      KEYCLOAK_URL: http://keycloak:8080
      KEYCLOAK_PUBLIC_URL: http://localhost:18180
      KEYCLOAK_REALM: daily2
      OWNER_SUB: 11111111-1111-1111-1111-111111111111
      MCP_RESOURCE_URL: http://localhost:18100/mcp
      MCP_ALLOWED_HOSTS: '["localhost:18100"]'
      LOG_JSON: "false"
    ports: ["18100:8000"]

volumes:
  daily2_db:
```

Tests keep using the separate `daily2-testdb` container from Task 3 (or CI's service); the
compose `db` is for running the app. Both publish 55433, so stop `daily2-testdb` before
`docker compose up`, or run the stack with `-p daily2-e2e` and a `db` port override. In
the README, document the one you use.

- [ ] **Step 3: E2E scenario**

`e2e/scenario.py`:

```python
"""Spec §11 end to end: real Keycloak, real Postgres, real HTTP, no mocks.

Run against `docker compose up -d --build --wait`:
    uv run --project backend python e2e/scenario.py
"""

import json
import sys
from typing import Any

import httpx

BASE = "http://localhost:18100"
TOKEN_URL = "http://localhost:18180/realms/daily2/protocol/openid-connect/token"
MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def check(name: str, condition: bool, detail: Any = "") -> None:
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        print(f"     {detail}")
        sys.exit(1)


def token(client_id: str, secret: str | None = None) -> str:
    data = {"grant_type": "password", "client_id": client_id, "username": "dev", "password": "dev", "scope": "openid"}
    if secret:
        data["client_secret"] = secret
    response = httpx.post(TOKEN_URL, data=data, timeout=10)
    response.raise_for_status()
    return response.json()["access_token"]


def tool(client: httpx.Client, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}, headers=MCP_HEADERS)
    response.raise_for_status()
    text = response.text
    envelope = json.loads([line[5:] for line in text.splitlines() if line.startswith("data:")][-1]) if "text/event-stream" in response.headers.get("content-type", "") else response.json()
    result = envelope["result"]
    check(f"mcp {name} succeeded", not result.get("isError"), result)
    return result["structuredContent"]


def main() -> None:
    app = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token('daily2-app')}"}, timeout=20)
    claude = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token('daily2-mcp', 'dev-mcp-secret')}"}, timeout=20)
    anonymous = httpx.Client(base_url=BASE, timeout=20)

    check("health is ok", anonymous.get("/health").json().get("status") == "ok")
    check("REST without a token is 401", anonymous.get("/api/v2/views/today").status_code == 401)
    check("REST with the MCP client's token is 403", claude.get("/api/v2/views/today").status_code == 403)

    context = tool(claude, "get_context", {"date": "2026-09-30"})
    check("get_context returns the day", context["day"]["summary"]["day"] == "2026-09-30")

    food = app.post("/api/v2/commands/save_food", json={"name": "E2E Skyr", "per_100": {"kcal": 62, "protein_g": 11}}).json()["result"]
    breakfast = tool(claude, "log_events", {"events": [{"kind": "intake", "occurred_at": "2026-09-30T08:00:00+02:00", "payload": {"items": [{"food_id": food["id"], "grams": 250}], "slot": "breakfast"}}]})["result"]["events"][0]
    check("breakfast logged by claude", breakfast["source"] == "claude" and breakfast["payload"]["nutrients"]["kcal"] == 155)

    symptom = tool(claude, "log_events", {"events": [{"kind": "symptom", "occurred_at": "2026-09-30T10:00:00+02:00", "payload": {"type": "bloated", "severity": 3}, "links": [{"to_chain": breakfast["chain_id"], "relation": "suspected_cause"}]}]})["result"]["events"][0]
    check("symptom linked to breakfast", symptom["links"][0]["chain_id"] == breakfast["chain_id"])

    corrected = app.post("/api/v2/commands/correct_event", json={"id": breakfast["id"], "payload": {"items": [{"food_id": food["id"], "grams": 300}], "slot": "breakfast"}}).json()["result"]
    check("breakfast corrected to version 2", corrected["version"] == 2)

    diary = app.get("/api/v2/views/diary", params={"days": 1}).json()
    day_events = {e["chain_id"]: e for d in diary["days"] for e in d["events"]}
    check("diary shows the corrected head", day_events.get(breakfast["chain_id"], {}).get("payload", {}).get("items", [{}])[0].get("grams") == 300, diary)

    history = app.get("/api/v2/views/event", params={"chain_id": breakfast["chain_id"]}).json()
    check("history keeps both versions", [v["version"] for v in history["versions"]] == [1, 2])

    tool(claude, "retract_event", {"id": symptom["id"], "reason": "e2e"})
    day = app.get("/api/v2/views/day", params={"date": "2026-09-30"}).json()
    check("retracted symptom no longer counts", day["summary"]["symptoms"] == [], day["summary"]["symptoms"])

    tool(claude, "retract_event", {"id": corrected["id"], "reason": "e2e cleanup"})
    print("All checks passed.")


if __name__ == "__main__":
    main()
```

Run it:

```bash
docker rm -f daily2-testdb
docker compose up -d --build --wait
uv run --project backend python e2e/scenario.py
```

Expected: every line `PASS`, then `All checks passed.`

Then run `uv run --project backend ruff check ../e2e` and `ruff format --check ../e2e`
from `backend/`, and make sure both pass.

- [ ] **Step 4: CI job for E2E**

Append to `.github/workflows/ci.yml`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    needs: backend
    steps:
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v7
        with:
          python-version: "3.14"
      - run: docker compose up -d --build --wait
      - run: uv run --project backend python e2e/scenario.py
      - if: failure()
        run: docker compose logs
```

- [ ] **Step 5: README**

Replace the `## Backend` section of `README.md` with:

```markdown
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

## Local stack and E2E

    docker rm -f daily2-testdb          # compose's db uses the same port
    docker compose up -d --build --wait # Postgres 55433, Keycloak 18180 (admin/admin, dev-only), backend 18100
    uv run --project backend python e2e/scenario.py

The dev realm `daily2` has one user `dev`/`dev` (id `11111111-…`, the owner) and three
clients: `daily2-app` (public), `daily2-mcp` (secret `dev-mcp-secret`) and
`daily2-gymbro-sync` (secret `dev-sync-secret`). Every one of these credentials is
dev-only.
```

- [ ] **Step 6: Commit**

```bash
git add backend/Dockerfile backend/.dockerignore backend/docker-entrypoint.sh docker-compose.yml keycloak e2e .github README.md
git commit -m "feat: container, local stack with a dev realm, E2E scenario and CI

Refs #<issue>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Done when (spec §12, backend part)

- `uv run pytest -q` passes with `TEST_DATABASE_URL` set, and ruff is clean.
- The Alembic round trip is clean (`alembic check`: no new operations).
- `e2e/scenario.py` prints `All checks passed.` against the compose stack.
- CI is green on the PR: backend, migrations and e2e.
- The PR body carries these command outputs, and every mention of `<issue>` above is the
  implementation issue opened for this plan.

The UI (plan 2) and the homelab deploy (plan 3) complete Core.
