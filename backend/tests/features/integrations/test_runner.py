import asyncio
import logging
from datetime import date, timedelta

import pytest

from app.features.integrations import integrations
from app.features.integrations.adapters import GymBroAdapter, override_adapters
from app.features.integrations.functions import run_adapter, sync_status
from app.features.integrations.models import SyncState
from app.features.journal.functions import heads_between
from app.helpers.auth import SYSTEM
from app.helpers.config import get_settings
from app.helpers.endpoints import Context
from app.helpers.time import utcnow
from tests.conftest import requires_db
from tests.features.integrations.fakes import FakeAdapter, workout
from tests.features.integrations.test_gym_bro import SESSION

pytestmark = requires_db


@pytest.fixture
def fake():
    adapter = FakeAdapter([workout("w1"), workout("w2", 500)])
    override_adapters({"fake": adapter})
    yield adapter
    override_adapters(None)


async def _heads(db):
    return await heads_between(db, date(2026, 9, 28), date(2026, 9, 28), include_retracted=True)


def _ctx(db) -> Context:
    return Context(session=db, principal=SYSTEM, settings=get_settings(), now=utcnow())


async def test_first_run_creates_then_repeats_are_unchanged(db, fake):
    status, days = await run_adapter(_ctx(db), fake)
    assert status.counts["created"] == 2
    assert status.last_error is None
    assert days
    again, _ = await run_adapter(_ctx(db), fake)
    assert again.counts == {
        "created": 0,
        "corrected": 0,
        "unchanged": 2,
        "retracted": 0,
        "invalid": 0,
    }
    assert fake.cursors[0] is None and fake.cursors[1] is not None


async def test_a_run_skipped_for_the_lock_leaves_the_status_untouched(db, fake, monkeypatch):
    first, _ = await run_adapter(_ctx(db), fake)

    async def held(session, key):
        return False

    monkeypatch.setattr("app.features.integrations.functions.try_advisory_xact_lock", held)
    later = Context(
        session=db, principal=SYSTEM, settings=get_settings(), now=utcnow() + timedelta(hours=1)
    )
    skipped, days = await run_adapter(later, fake)
    assert days == set()
    assert skipped.last_attempt_at == first.last_attempt_at
    assert skipped.counts == first.counts


async def test_missing_items_are_retracted_and_bad_items_skipped(db, fake):
    await run_adapter(_ctx(db), fake)
    fake.drafts = [workout("w1"), workout("bad").model_copy(update={"payload": {"title": ""}})]
    status, _ = await run_adapter(_ctx(db), fake)
    assert (status.counts["retracted"], status.counts["invalid"]) == (1, 1)
    events = await heads_between(db, date(2026, 9, 28), date(2026, 9, 28))
    assert [e.payload["volume_kg"] for e in events] == [1000]


async def test_a_failing_source_records_the_error_and_keeps_data(db, fake):
    await run_adapter(_ctx(db), fake)
    before = [(e.id, e.retracted) for e in await _heads(db)]
    cursor = (await db.get(SyncState, "fake")).cursor
    fake.fail = True
    status, days = await run_adapter(_ctx(db), fake)
    assert (status.last_error, days) == ("fake source is down", set())
    assert status.counts["created"] == 2
    assert [(e.id, e.retracted) for e in await _heads(db)] == before
    assert (await db.get(SyncState, "fake")).cursor == cursor
    [listed] = await sync_status(db, get_settings())
    assert (listed.source, listed.configured, listed.last_error) == (
        "fake",
        True,
        "fake source is down",
    )


async def test_sync_now_over_rest(rest, fake):
    ok = (await rest.post("/api/v2/commands/sync_now", json={"source": "fake"})).json()
    assert ok["result"]["counts"]["created"] == 2
    unknown = await rest.post("/api/v2/commands/sync_now", json={"source": "ring"})
    assert (unknown.status_code, unknown.json()["field"]) == (404, "source")


async def test_an_unexpected_fetch_error_is_recorded_without_its_message(db, fake, caplog):
    await run_adapter(_ctx(db), fake)
    before = [(e.id, e.retracted) for e in await _heads(db)]

    async def boom(cursor, now):
        raise RuntimeError("secret detail")

    fake.fetch = boom
    with caplog.at_level(logging.ERROR, logger="integrations"):
        status, days = await run_adapter(_ctx(db), fake)
    assert (status.last_error, days) == ("unexpected error: RuntimeError", set())
    assert [(e.id, e.retracted) for e in await _heads(db)] == before
    assert any(r.exc_info for r in caplog.records)


def _session(session_id: str, **override):
    session = {**SESSION, "id": session_id, **override}
    return {k: v for k, v in session.items() if v is not None}


class _Client:
    def __init__(self, sessions):
        self.sessions = sessions

    async def completed_sessions(self, owner_sub, since):
        return self.sessions


async def test_an_unmappable_session_is_skipped_and_not_retracted(db):
    good, other = _session("g-1"), _session("g-2")
    client = _Client([good, other])
    adapter = GymBroAdapter(client, "owner", 60)
    first, _ = await run_adapter(_ctx(db), adapter)
    assert first.counts["created"] == 2
    client.sessions = [good, _session("g-2", started_at=None)]
    status, _ = await run_adapter(_ctx(db), adapter)
    assert status.last_error is None
    assert (status.counts["invalid"], status.counts["retracted"]) == (1, 0)
    assert len([e for e in await _heads(db) if not e.retracted]) == 2


async def test_fetch_reports_invalid_and_seen_ids():
    adapter = GymBroAdapter(
        _Client([_session("a"), _session("b", started_at=None), {"name": "no id"}]), "o", 60
    )
    result = await adapter.fetch(None, utcnow())
    assert [d.external_id for d in result.drafts] == ["a"]
    assert (result.invalid, result.seen_ids) == (2, {"a", "b"})


async def _wait_for(predicate, timeout=5.0):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


async def test_a_failing_loop_run_is_logged_and_the_loop_continues(fake, monkeypatch, caplog):
    calls = []

    async def fake_execute(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("run failed")

    monkeypatch.setattr(integrations, "execute", fake_execute)
    monkeypatch.setattr(integrations, "FIRST_RUN_DELAY_SECONDS", 0)
    monkeypatch.setattr(fake, "interval_seconds", 0)
    with caplog.at_level(logging.ERROR, logger="integrations"):
        async with integrations.sync_loops(None):
            await _wait_for(lambda: len(calls) >= 2)
    assert any("sync loop run failed" in r.getMessage() for r in caplog.records)


async def test_leaving_the_lifespan_cancels_the_loops(fake, monkeypatch):
    created = []
    real = asyncio.create_task

    def spy(coro):
        task = real(coro)
        created.append(task)
        return task

    monkeypatch.setattr(integrations.asyncio, "create_task", spy)
    async with integrations.sync_loops(None):
        assert len(created) == 1 and not created[0].done()
    assert created[0].done()


async def test_no_configured_adapters_start_no_tasks(monkeypatch):
    override_adapters({})
    try:
        created = []
        monkeypatch.setattr(integrations.asyncio, "create_task", created.append)
        async with integrations.sync_loops(None):
            pass
    finally:
        override_adapters(None)
    assert created == []


async def test_sync_loops_start_and_stop(fake):
    from app.features.integrations.integrations import sync_loops

    async with sync_loops(None):
        pass
