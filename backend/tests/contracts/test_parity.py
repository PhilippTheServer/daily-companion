from typing import Any

from tests.clients import call_tool
from tests.conftest import requires_db
from tests.features.journal.helpers import food
from tests.features.journal.test_payloads import EXAMPLES

pytestmark = requires_db

DAY = "2026-09-30"
AT = "2026-09-30T08:00:00+02:00"
ENDS = {
    "sleep": "2026-09-30T09:00:00+02:00",
    "activity": "2026-10-01T00:00:00+02:00",
    "workout": "2026-09-30T09:00:00+02:00",
}


def _drafts(food_id: str) -> list[dict[str, Any]]:
    drafts = []
    for kind, payload in EXAMPLES.items():
        if kind == "intake":
            payload = {"items": [{"food_id": food_id, "grams": 150}], "slot": "breakfast"}
        occurred = "2026-09-30T00:00:00+02:00" if kind == "activity" else AT
        draft = {"kind": kind, "occurred_at": occurred, "payload": payload}
        if kind in ENDS:
            draft["ends_at"] = ENDS[kind]
        drafts.append(draft)
    return drafts


def _comparable(view: dict[str, Any]) -> dict[str, Any]:
    timeline = [(e["kind"], e["occurred_at"], e["ends_at"], e["payload"]) for e in view["timeline"]]
    summary = dict(view["summary"])
    summary.pop("steps", None)
    return {"summary": summary, "timeline": sorted(timeline, key=repr)}


async def test_rest_and_mcp_produce_the_same_day_for_every_kind(rest, mcp):
    skyr = await food(rest)
    drafts = _drafts(skyr["id"])
    via_rest = (await rest.post("/api/v2/commands/log_events", json={"events": drafts})).json()[
        "result"
    ]["events"]
    rest_view = (await rest.get("/api/v2/views/day", params={"date": DAY})).json()
    for event in via_rest:
        await rest.post("/api/v2/commands/retract_event", json={"id": event["id"]})
    async with mcp() as client:
        via_mcp = (await call_tool(client, "log_events", {"events": drafts}))["result"]["events"]
        mcp_view = await call_tool(client, "get_day", {"date": DAY})
    assert {e["source"] for e in via_rest} == {"app"}
    assert {e["source"] for e in via_mcp} == {"claude"}
    assert _comparable(rest_view) == _comparable(mcp_view)
