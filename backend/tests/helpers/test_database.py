import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

from app.helpers.database import open_session, ping, try_advisory_xact_lock
from app.helpers.errors import Conflict
from app.helpers.idempotency import remember, replay
from tests.conftest import TEST_DATABASE_URL, requires_db

pytestmark = requires_db


async def test_open_session_uses_the_overridden_provider(db):
    async with open_session() as session:
        assert session is db
        await ping(session)


async def test_advisory_lock_blocks_other_connections(db):
    assert await try_advisory_xact_lock(db, 4242) is True
    engine = create_async_engine(TEST_DATABASE_URL, connect_args={"options": "-c timezone=utc"})
    async with engine.connect() as other:
        result = await other.scalar(sa.select(sa.func.pg_try_advisory_xact_lock(4242)))
        assert result is False
    await engine.dispose()


async def test_replay_returns_the_remembered_response(db):
    assert await replay(db, "k1", "log_events") is None
    remember(db, "k1", "log_events", {"result": {"n": 1}})
    await db.flush()
    db.expunge_all()
    assert await replay(db, "k1", "log_events") == {"result": {"n": 1}}


async def test_replay_rejects_a_key_used_for_another_command(db):
    remember(db, "k2", "log_events", {"result": {}})
    await db.flush()
    db.expunge_all()
    with pytest.raises(Conflict) as caught:
        await replay(db, "k2", "retract_event")
    assert caught.value.field == "idempotency_key"
