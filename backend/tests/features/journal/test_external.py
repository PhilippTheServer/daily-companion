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


def _workout(
    external_id: str, volume: float, started: str = "2026-09-28T17:00:00Z"
) -> ExternalDraft:
    return ExternalDraft(
        external_id=external_id,
        content_hash=f"hash-{volume}",
        kind="workout",
        occurred_at=started,
        ends_at="2026-09-28T17:31:00Z",
        payload={"title": "Push", "category": "strength", "volume_kg": volume},
    )


async def _heads(db, source: str) -> list[Event]:
    statement = select(Event).where(Event.external_source == source, Event.is_head)
    return list((await db.scalars(statement)).all())


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
    since = datetime(2026, 9, 14, tzinfo=UTC)
    count, days = await retract_missing(ctx, "gym-bro", since, seen=set())
    assert (count, days) == (1, {datetime(2026, 9, 28).date()})
    heads = {h.external_id: h for h in await _heads(db, "gym-bro")}
    chain_id = heads["w1"].chain_id
    assert heads["w1"].retract_reason == REMOVED_AT_SOURCE
    assert heads["w2"].retracted_at is None
    assert (await upsert_external(ctx, "gym-bro", _workout("w1", 1000)))[0] == "corrected"
    restored = {h.external_id: h for h in await _heads(db, "gym-bro")}["w1"]
    assert restored.retracted_at is None
    assert (restored.version, restored.chain_id) == (2, chain_id)


async def test_owner_retraction_is_respected(db):
    ctx = _ctx(db)
    await upsert_external(ctx, "gym-bro", _workout("w1", 1000))
    [head] = await _heads(db, "gym-bro")
    head.retracted_at = utcnow()
    head.retract_reason = "test session"
    await db.flush()
    assert (await upsert_external(ctx, "gym-bro", _workout("w1", 1000)))[0] == "unchanged"


async def test_owner_retraction_survives_a_source_edit(db):
    ctx = _ctx(db)
    await upsert_external(ctx, "gym-bro", _workout("w1", 1000))
    [head] = await _heads(db, "gym-bro")
    head.retracted_at = utcnow()
    head.retract_reason = "test session"
    await db.flush()
    assert await upsert_external(ctx, "gym-bro", _workout("w1", 1200)) == ("unchanged", set())
    [still] = await _heads(db, "gym-bro")
    assert (still.version, still.retract_reason) == (1, "test session")


async def test_retract_missing_keeps_items_the_source_still_lists(db):
    ctx = _ctx(db)
    await upsert_external(ctx, "gym-bro", _workout("w1", 1000))
    await upsert_external(ctx, "gym-bro", _workout("w2", 500))
    since = datetime(2026, 9, 14, tzinfo=UTC)
    count, _ = await retract_missing(ctx, "gym-bro", since, seen={"w1"})
    heads = {h.external_id: h for h in await _heads(db, "gym-bro")}
    assert count == 1
    assert heads["w1"].retracted_at is None
    assert heads["w2"].retract_reason == REMOVED_AT_SOURCE
