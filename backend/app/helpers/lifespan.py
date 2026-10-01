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
        try:
            await services.aclose()
        finally:
            await dispose_engine()
