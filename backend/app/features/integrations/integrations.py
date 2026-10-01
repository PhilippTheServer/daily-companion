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
    tasks = [
        asyncio.create_task(_loop(adapter))
        for adapter in configured_adapters(get_settings()).values()
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task


api = FeatureApi(name="integrations", operations=OPERATIONS, lifespan=sync_loops)
