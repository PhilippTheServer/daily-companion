"""GET /health: version, uptime and database reachability, for probes and monitoring."""

import time
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.helpers.config import app_version
from app.helpers.database import open_session, ping
from app.helpers.logging import get_logger

router = APIRouter(tags=["health"])
_started = time.monotonic()
logger = get_logger("health")


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
        database = DatabaseHealth(
            ok=True, latency_ms=round((time.perf_counter() - started) * 1000, 1)
        )
    except Exception:
        logger.warning("database check failed", exc_info=True)
        database = DatabaseHealth(ok=False, latency_ms=None)
    body = Health(
        status="ok" if database.ok else "degraded",
        version=app_version(),
        uptime_seconds=round(time.monotonic() - _started, 1),
        database=database,
    )
    return JSONResponse(body.model_dump(), status_code=200 if database.ok else 503)
