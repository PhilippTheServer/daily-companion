from datetime import UTC, datetime, timedelta

from app.features.profile.functions import profile_for, timezone_at
from app.features.profile.models import ProfileVersion
from tests.clients import call_tool
from tests.conftest import requires_db

pytestmark = requires_db


async def test_first_update_fills_defaults(rest):
    body = (await rest.post("/api/v2/commands/update_profile", json={"height_cm": 180})).json()
    profile = body["result"]
    assert profile["height_cm"] == 180
    assert profile["timezone"] == "Europe/Berlin"
    assert (profile["protein_g_per_kg"], profile["fat_g_per_kg_min"]) == (1.8, 0.8)
    assert len(body["effects"]["days"]) == 1


async def test_only_sent_fields_change_and_null_clears(rest):
    await rest.post("/api/v2/commands/update_profile", json={"height_cm": 180, "sex": "male"})
    second = (await rest.post("/api/v2/commands/update_profile", json={"sex": None})).json()[
        "result"
    ]
    assert second["height_cm"] == 180
    assert second["sex"] is None


async def test_goal_needs_weight_and_date_together(rest):
    response = await rest.post("/api/v2/commands/update_profile", json={"goal_weight_kg": 77})
    assert response.status_code == 422
    assert response.json() == {
        "code": "validation",
        "message": "goal_weight_kg and goal_date must be set together",
        "field": "goal_date",
    }
    ok = await rest.post(
        "/api/v2/commands/update_profile", json={"goal_weight_kg": 77, "goal_date": "2027-01-01"}
    )
    assert ok.status_code == 200


async def test_required_fields_cannot_be_cleared_and_timezone_must_exist(rest):
    cleared = await rest.post("/api/v2/commands/update_profile", json={"timezone": None})
    assert (cleared.status_code, cleared.json()["field"]) == (422, "timezone")
    unknown = await rest.post("/api/v2/commands/update_profile", json={"timezone": "Mars/Base"})
    assert (unknown.status_code, unknown.json()["field"]) == (422, "timezone")


async def test_timezone_at_uses_the_version_valid_at_that_moment(db):
    now = datetime(2026, 9, 30, 12, tzinfo=UTC)
    db.add(
        ProfileVersion(
            valid_from=now, timezone="Asia/Tokyo", protein_g_per_kg=1.8, fat_g_per_kg_min=0.8
        )
    )
    await db.flush()
    assert await timezone_at(db, now - timedelta(days=1), "Europe/Berlin") == "Europe/Berlin"
    assert await timezone_at(db, now + timedelta(days=1), "Europe/Berlin") == "Asia/Tokyo"
    assert (await profile_for(db, now - timedelta(days=1))).timezone == "Asia/Tokyo"


async def test_source_preference_is_upserted_through_mcp(mcp):
    async with mcp() as client:
        await call_tool(client, "set_source_preference", {"metric": "steps", "sources": ["app"]})
        body = await call_tool(
            client, "set_source_preference", {"metric": "steps", "sources": ["ring", "app"]}
        )
    assert body["result"] == {"metric": "steps", "sources": ["ring", "app"]}


async def test_update_profile_over_mcp_changes_only_the_fields_sent(rest, mcp):
    await rest.post(
        "/api/v2/commands/update_profile", json={"timezone": "Asia/Tokyo", "height_cm": 180}
    )
    async with mcp() as client:
        updated = await call_tool(client, "update_profile", {"sex": "male"})
    profile = updated["result"]
    assert (profile["timezone"], profile["height_cm"], profile["sex"]) == (
        "Asia/Tokyo",
        180,
        "male",
    )
