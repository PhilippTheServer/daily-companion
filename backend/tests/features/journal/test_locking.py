import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.features.journal.exceptions import StaleHead
from app.features.journal.functions import _head
from app.features.journal.models import Event
from tests.conftest import TEST_DATABASE_URL, requires_db

pytestmark = requires_db


async def test_a_second_writer_waits_for_the_head_lock_then_sees_it_stale(schema):
    engine = create_async_engine(TEST_DATABASE_URL, connect_args={"options": "-c timezone=utc"})
    factory = async_sessionmaker(bind=engine, expire_on_commit=False)
    chain_id = uuid.uuid4()
    now = datetime(2026, 9, 30, tzinfo=UTC)
    try:
        async with factory() as seed:
            seed.add(
                Event(
                    id=chain_id,
                    chain_id=chain_id,
                    version=1,
                    is_head=True,
                    kind="note",
                    schema_version=1,
                    occurred_at=now,
                    local_day=now.date(),
                    payload={"text": "x"},
                    source="app",
                    recorded_at=now,
                )
            )
            await seed.commit()
        async with factory() as a, factory() as b:
            held = await _head(a, chain_id)
            waiting = asyncio.create_task(_head(b, chain_id))
            await asyncio.sleep(0.2)
            assert not waiting.done()
            held.is_head = False
            await a.commit()
            with pytest.raises(StaleHead):
                await asyncio.wait_for(waiting, 5)
    finally:
        async with factory() as cleanup:
            await cleanup.execute(delete(Event).where(Event.chain_id == chain_id))
            await cleanup.commit()
        await engine.dispose()
