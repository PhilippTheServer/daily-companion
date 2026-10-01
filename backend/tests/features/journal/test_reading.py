from datetime import date

from app.features.journal.functions import days_with_events, latest_measurement, measurements
from tests.clients import call_tool, call_tool_error
from tests.conftest import requires_db
from tests.features.journal.helpers import draft, logged

pytestmark = requires_db


def weight(value: float, at: str) -> dict:
    return draft("measurement", {"metric": "weight_kg", "value": value}, occurred_at=at)


async def test_latest_measurement_and_series(rest, db):
    await logged(
        rest,
        weight(85.5, "2026-09-28T07:00:00+02:00"),
        weight(84.3, "2026-09-29T07:00:00+02:00"),
        weight(99, "2026-10-05T07:00:00+02:00"),
    )
    latest = await latest_measurement(db, "weight_kg", date(2026, 9, 30))
    assert latest.payload["value"] == 84.3
    assert await latest_measurement(db, "hrv_ms", date(2026, 9, 30)) is None
    series = await measurements(db, "weight_kg", date(2026, 9, 28), date(2026, 9, 29))
    assert [e.payload["value"] for e in series] == [85.5, 84.3]


async def test_days_with_events_pages_backwards(rest, db):
    await logged(
        rest,
        draft("note", {"text": "a"}, occurred_at="2026-09-20T10:00:00Z"),
        draft("note", {"text": "b"}, occurred_at="2026-09-25T10:00:00Z"),
        draft("checkin", {"overall": 3}, occurred_at="2026-09-27T10:00:00Z"),
    )
    assert await days_with_events(db, None, 2) == [date(2026, 9, 27), date(2026, 9, 25)]
    assert await days_with_events(db, date(2026, 9, 25), 5) == [date(2026, 9, 20)]
    assert await days_with_events(db, None, 5, kinds=["checkin"]) == [date(2026, 9, 27)]


async def test_query_events_through_mcp_with_filters_and_range_checks(mcp, rest):
    note, _ = await logged(rest, draft("note", {"text": "a"}), draft("checkin", {"overall": 2}))
    await rest.post("/api/v2/commands/retract_event", json={"id": note["id"]})
    window = {"from_day": "2026-09-30", "to_day": "2026-09-30"}
    async with mcp() as client:
        visible = await call_tool(client, "query_events", window)
        assert [e["kind"] for e in visible["events"]] == ["checkin"]
        everything = await call_tool(client, "query_events", {**window, "include_retracted": True})
        assert len(everything["events"]) == 2
        only = await call_tool(
            client, "query_events", {**window, "kinds": ["note"], "include_retracted": True}
        )
        assert [e["kind"] for e in only["events"]] == ["note"]
        backwards = await call_tool_error(
            client, "query_events", {"from_day": "2026-09-30", "to_day": "2026-09-01"}
        )
        assert backwards["field"] == "to_day"
        too_long = await call_tool_error(
            client, "query_events", {"from_day": "2025-01-01", "to_day": "2026-09-30"}
        )
    assert too_long["message"] == "a range covers at most 366 days"


async def test_retracted_heads_do_not_count_for_days_or_latest_measurement(rest, db):
    [old, new] = await logged(
        rest,
        weight(85.5, "2026-09-28T07:00:00+02:00"),
        weight(99, "2026-09-29T07:00:00+02:00"),
    )
    [note] = await logged(rest, draft("note", {"text": "x"}, occurred_at="2026-09-29T10:00:00Z"))
    for event in (new, note):
        await rest.post("/api/v2/commands/retract_event", json={"id": event["id"]})
    latest = await latest_measurement(db, "weight_kg", date(2026, 9, 30))
    assert latest.payload["value"] == 85.5
    assert old["id"] == str(latest.id)
    assert await days_with_events(db, None, 5) == [date(2026, 9, 28)]
