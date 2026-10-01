#!/bin/sh
# Refreshes the backend contract the frontend is built against: openapi.json, the
# GET /api/v2/schemas snapshot the form tests use, and the generated TypeScript types.
set -eu
frontend="$(cd "$(dirname "$0")/.." && pwd)"
cd "$frontend/../backend"
uv run --locked python - "$frontend" <<'PY'
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
