from tests.clients import call_tool
from tests.conftest import requires_db
from tests.features.journal.helpers import draft, food, log, logged

pytestmark = requires_db


async def test_intake_snapshots_nutrients_and_uses_the_local_day(rest):
    skyr = await food(rest)
    [event] = await logged(
        rest,
        draft(
            "intake",
            {"items": [{"food_id": skyr["id"], "grams": 250}]},
            occurred_at="2026-09-30T22:30:00Z",
        ),
    )
    assert event["local_day"] == "2026-10-01"
    assert (event["version"], event["source"], event["retracted"]) == (1, "app", False)
    assert event["payload"]["nutrients"]["kcal"] == 155
    assert event["payload"]["items"][0]["name"] == "Skyr"


async def test_intake_from_a_recipe_scales_to_portions(rest):
    skyr = await food(rest)
    recipe = (
        await rest.post(
            "/api/v2/commands/save_recipe",
            json={"name": "Bowl", "serves": 2, "items": [{"food_id": skyr["id"], "grams": 400}]},
        )
    ).json()["result"]
    [event] = await logged(rest, draft("intake", {"recipe_id": recipe["id"], "portions": 1}))
    assert event["payload"]["items"][0]["grams"] == 200
    assert event["payload"]["recipe_version_id"] == recipe["version_id"]


async def test_drinks_count_as_fluid(rest):
    water = await food(rest, "Wasser", 0, 0, kind="drink")
    [event] = await logged(
        rest, draft("intake", {"items": [{"food_id": water["id"], "grams": 500}]})
    )
    assert event["payload"]["nutrients"]["fluid_ml"] == 500


async def test_time_rules_per_kind(rest):
    no_end = await log(rest, draft("sleep", {"quality": 3}))
    assert (no_end.status_code, no_end.json()["field"]) == (422, "events.0.ends_at")
    reversed_ = await log(
        rest, draft("sleep", {}, occurred_at="2026-09-30T07:00:00Z", ends_at="2026-09-29T23:00:00Z")
    )
    assert (reversed_.status_code, reversed_.json()["field"]) == (422, "events.0.ends_at")
    forbidden = await log(
        rest,
        draft("measurement", {"metric": "weight_kg", "value": 84}, ends_at="2026-09-30T09:00:00Z"),
    )
    assert (forbidden.status_code, forbidden.json()["field"]) == (422, "events.0.ends_at")


async def test_payload_and_reference_errors_name_the_field(rest):
    bad = await log(rest, draft("symptom", {"type": "bloated", "severity": 9}))
    assert bad.status_code == 422
    assert bad.json()["field"].startswith("events.0") and bad.json()["field"].endswith("severity")
    unknown_food = await log(
        rest,
        draft(
            "intake", {"items": [{"food_id": "00000000-0000-0000-0000-000000000009", "grams": 1}]}
        ),
    )
    assert (unknown_food.status_code, unknown_food.json()["field"]) == (
        404,
        "events.0.payload.items.0.food_id",
    )
    unknown_link = await log(
        rest,
        draft(
            "note",
            {"text": "x"},
            links=[{"to_chain": "00000000-0000-0000-0000-000000000009", "relation": "follows"}],
        ),
    )
    assert (unknown_link.status_code, unknown_link.json()["field"]) == (
        404,
        "events.0.links.0.to_chain",
    )


async def test_a_symptom_links_to_its_suspected_meal(rest):
    skyr = await food(rest)
    [meal] = await logged(rest, draft("intake", {"items": [{"food_id": skyr["id"], "grams": 100}]}))
    [symptom] = await logged(
        rest,
        draft(
            "symptom",
            {"type": "bloated", "severity": 3},
            links=[{"to_chain": meal["chain_id"], "relation": "suspected_cause"}],
        ),
    )
    assert symptom["links"] == [
        {"chain_id": meal["chain_id"], "relation": "suspected_cause", "direction": "outgoing"}
    ]
    history = (await rest.get("/api/v2/views/event", params={"chain_id": meal["chain_id"]})).json()
    assert history["links"] == [
        {"chain_id": symptom["chain_id"], "relation": "suspected_cause", "direction": "incoming"}
    ]


async def test_correcting_adds_a_version_and_old_ids_become_stale(rest):
    [note] = await logged(rest, draft("note", {"text": "first"}))
    fixed = (
        await rest.post(
            "/api/v2/commands/correct_event", json={"id": note["id"], "payload": {"text": "second"}}
        )
    ).json()["result"]
    assert (fixed["chain_id"], fixed["version"], fixed["payload"]["text"]) == (
        note["chain_id"],
        2,
        "second",
    )
    stale = await rest.post(
        "/api/v2/commands/correct_event", json={"id": note["id"], "payload": {"text": "third"}}
    )
    assert (stale.status_code, stale.json()["code"]) == (409, "stale_head")
    history = (await rest.get("/api/v2/views/event", params={"chain_id": note["chain_id"]})).json()
    assert [v["payload"]["text"] for v in history["versions"]] == ["first", "second"]


async def test_correcting_times_and_links_survive(rest):
    [meal] = await logged(rest, draft("note", {"text": "meal"}))
    [symptom] = await logged(
        rest,
        draft(
            "symptom",
            {"type": "gas", "severity": 2},
            links=[{"to_chain": meal["chain_id"], "relation": "suspected_cause"}],
        ),
    )
    moved = (
        await rest.post(
            "/api/v2/commands/correct_event",
            json={"id": symptom["id"], "occurred_at": "2026-10-01T09:00:00Z"},
        )
    ).json()
    assert moved["result"]["local_day"] == "2026-10-01"
    assert sorted(moved["effects"]["days"]) == ["2026-09-30", "2026-10-01"]
    assert moved["result"]["links"][0]["chain_id"] == meal["chain_id"]
    empty = await rest.post("/api/v2/commands/correct_event", json={"id": moved["result"]["id"]})
    assert empty.status_code == 422


async def test_retracting_is_idempotent_and_blocks_corrections(rest):
    [note] = await logged(rest, draft("note", {"text": "oops"}))
    first = (
        await rest.post(
            "/api/v2/commands/retract_event", json={"id": note["id"], "reason": "duplicate"}
        )
    ).json()["result"]
    again = (await rest.post("/api/v2/commands/retract_event", json={"id": note["id"]})).json()[
        "result"
    ]
    assert first["retracted"] and again["retracted"]
    blocked = await rest.post(
        "/api/v2/commands/correct_event", json={"id": note["id"], "payload": {"text": "x"}}
    )
    assert (blocked.status_code, blocked.json()["code"]) == (409, "conflict")
    missing = await rest.post(
        "/api/v2/commands/retract_event", json={"id": "00000000-0000-0000-0000-000000000009"}
    )
    assert missing.status_code == 404


async def test_link_and_unlink(rest):
    [a, b] = await logged(rest, draft("note", {"text": "a"}), draft("note", {"text": "b"}))
    body = {"from_chain": a["chain_id"], "to_chain": b["chain_id"], "relation": "follows"}
    assert (await rest.post("/api/v2/commands/link_events", json=body)).status_code == 200
    assert (await rest.post("/api/v2/commands/link_events", json=body)).status_code == 200
    self_link = await rest.post(
        "/api/v2/commands/link_events", json=body | {"to_chain": a["chain_id"]}
    )
    assert (self_link.status_code, self_link.json()["field"]) == (422, "to_chain")
    assert (await rest.post("/api/v2/commands/unlink_events", json=body)).status_code == 200
    gone = await rest.post("/api/v2/commands/unlink_events", json=body)
    assert (gone.status_code, gone.json()["code"]) == (404, "not_found")


async def test_idempotency_key_logs_once(rest):
    first = await log(rest, draft("note", {"text": "once"}), idempotency_key="log-1")
    second = await log(rest, draft("note", {"text": "once"}), idempotency_key="log-1")
    assert first.json() == second.json()


async def test_timezone_follows_the_profile(rest):
    await rest.post("/api/v2/commands/update_profile", json={"timezone": "Asia/Tokyo"})
    [event] = await logged(rest, draft("note", {"text": "x"}, occurred_at="2099-01-01T16:00:00Z"))
    assert event["local_day"] == "2099-01-02"


async def test_claude_logs_through_mcp(mcp):
    async with mcp() as client:
        body = await call_tool(client, "log_events", {"events": [draft("checkin", {"overall": 4})]})
    assert body["result"]["events"][0]["source"] == "claude"


async def test_correct_rejects_null_times_and_payloads(rest):
    [note] = await logged(rest, draft("note", {"text": "x"}))
    for name in ("occurred_at", "payload"):
        response = await rest.post(
            "/api/v2/commands/correct_event", json={"id": note["id"], name: None}
        )
        assert response.status_code == 422, name
        assert response.json()["field"] == name
        assert f"{name} cannot be null" in response.json()["message"]


async def test_correct_null_ends_at_clears_it(rest):
    [sleep] = await logged(rest, draft("sleep", {"quality": 3}, ends_at="2026-09-30T16:00:00Z"))
    response = await rest.post(
        "/api/v2/commands/correct_event", json={"id": sleep["id"], "ends_at": None}
    )
    assert (response.status_code, response.json()["field"]) == (422, "ends_at")
    [note] = await logged(rest, draft("note", {"text": "x"}))
    ok = await rest.post("/api/v2/commands/correct_event", json={"id": note["id"], "ends_at": None})
    assert ok.status_code == 200 and ok.json()["result"]["ends_at"] is None


async def test_correct_time_rules_and_stale_retract(rest):
    [sleep] = await logged(rest, draft("sleep", {}, ends_at="2026-09-30T16:00:00Z"))
    reversed_ = await rest.post(
        "/api/v2/commands/correct_event",
        json={"id": sleep["id"], "ends_at": "2026-09-30T01:00:00Z"},
    )
    assert (reversed_.status_code, reversed_.json()["field"]) == (422, "ends_at")
    [weight] = await logged(rest, draft("measurement", {"metric": "weight_kg", "value": 84}))
    forbidden = await rest.post(
        "/api/v2/commands/correct_event",
        json={"id": weight["id"], "ends_at": "2026-09-30T09:00:00Z"},
    )
    assert (forbidden.status_code, forbidden.json()["field"]) == (422, "ends_at")
    [note] = await logged(rest, draft("note", {"text": "a"}))
    await rest.post(
        "/api/v2/commands/correct_event", json={"id": note["id"], "payload": {"text": "b"}}
    )
    stale = await rest.post("/api/v2/commands/retract_event", json={"id": note["id"]})
    assert (stale.status_code, stale.json()["code"]) == (409, "stale_head")


async def test_history_of_an_unknown_chain_is_404(rest):
    response = await rest.get(
        "/api/v2/views/event", params={"chain_id": "00000000-0000-0000-0000-000000000009"}
    )
    assert (response.status_code, response.json()["field"]) == (404, "chain_id")


async def test_correct_event_over_mcp_keeps_what_is_not_sent(rest, mcp):
    [sleep] = await logged(rest, draft("sleep", {"quality": 3}, ends_at="2026-09-30T16:00:00Z"))
    async with mcp() as client:
        by_payload = await call_tool(
            client, "correct_event", {"id": sleep["id"], "payload": {"quality": 5}}
        )
        assert by_payload["result"]["payload"]["quality"] == 5
        assert by_payload["result"]["ends_at"] == sleep["ends_at"]
        by_end = await call_tool(
            client,
            "correct_event",
            {"id": by_payload["result"]["id"], "ends_at": "2026-09-30T15:00:00Z"},
        )
    assert by_end["result"]["payload"]["quality"] == 5
    assert by_end["result"]["occurred_at"] == sleep["occurred_at"]
    assert by_end["result"]["ends_at"].startswith("2026-09-30T15:00:00")


async def test_history_exposes_the_retract_reason_on_the_head(rest):
    [note, other] = await logged(
        rest, draft("note", {"text": "oops"}), draft("note", {"text": "ok"})
    )
    await rest.post(
        "/api/v2/commands/retract_event", json={"id": note["id"], "reason": "duplicate"}
    )
    retracted = (
        await rest.get("/api/v2/views/event", params={"chain_id": note["chain_id"]})
    ).json()
    head = retracted["versions"][-1]
    assert (head["retracted"], head["retract_reason"]) == (True, "duplicate")
    live = (await rest.get("/api/v2/views/event", params={"chain_id": other["chain_id"]})).json()
    assert (live["versions"][-1]["retracted"], live["versions"][-1]["retract_reason"]) == (
        False,
        None,
    )
