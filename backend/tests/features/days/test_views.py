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
        json={
            "height_cm": 180,
            "birth_date": "2001-04-02",
            "sex": "male",
            "goal_weight_kg": 77,
            "goal_date": "2027-01-01",
        },
    )


async def test_day_view_sums_the_day_and_counts_last_nights_sleep(rest):
    await _owner(rest)
    skyr = await food(rest)
    await logged(
        rest,
        draft(
            "measurement",
            {"metric": "weight_kg", "value": 84.3},
            occurred_at="2026-09-30T07:00:00+02:00",
        ),
        draft(
            "intake",
            {"items": [{"food_id": skyr["id"], "grams": 500}]},
            occurred_at="2026-09-30T08:00:00+02:00",
        ),
        draft(
            "sleep",
            {"quality": 4},
            occurred_at="2026-09-29T22:30:00+02:00",
            ends_at="2026-09-30T06:30:00+02:00",
        ),
        draft(
            "activity",
            {"steps": 8000},
            occurred_at="2026-09-30T00:00:00+02:00",
            ends_at="2026-10-01T00:00:00+02:00",
        ),
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
        draft(
            "measurement",
            {"metric": "weight_kg", "value": 85.5},
            occurred_at="2026-09-28T07:00:00+02:00",
        ),
        draft(
            "measurement",
            {"metric": "weight_kg", "value": 84.3},
            occurred_at="2026-09-29T07:00:00+02:00",
        ),
        draft("symptom", {"type": "gas", "severity": 2}, occurred_at="2026-09-29T20:00:00+02:00"),
    )
    async with mcp() as client:
        context = await call_tool(client, "get_context", {"date": "2026-09-30"})
    assert context["weight"] == {
        "latest_kg": 84.3,
        "latest_day": "2026-09-29",
        "trend_kg_per_week": -8.4,
    }
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
    second = (
        await rest.get("/api/v2/views/diary", params={"days": 2, "cursor": first["next_cursor"]})
    ).json()
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
    await rest.post(
        "/api/v2/commands/set_source_preference",
        json={"metric": "steps", "sources": ["ring", "app"]},
    )
    view = (await rest.get("/api/v2/views/profile")).json()
    assert view["profile"]["height_cm"] == 180
    assert view["source_preferences"] == [{"metric": "steps", "sources": ["ring", "app"]}]
    assert view["integrations"] == []
