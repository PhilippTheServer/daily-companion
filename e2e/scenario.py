"""Spec §11 end to end: real Keycloak, real Postgres, real HTTP, no mocks.

Run against `docker compose up -d --build --wait`:
    uv run --project backend python e2e/scenario.py
"""

import json
import sys
from typing import Any

import httpx

BASE = "http://localhost:18100"
TOKEN_URL = "http://localhost:18180/realms/daily2/protocol/openid-connect/token"
MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def check(name: str, condition: bool, detail: Any = "") -> None:
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        print(f"     {detail}")
        sys.exit(1)


def rest(client: httpx.Client, method: str, path: str, name: str, **kwargs: Any) -> Any:
    response = client.request(method, path, **kwargs)
    check(f"{name} returned 2xx", response.is_success, response.text)
    return response.json()


def token(client_id: str, secret: str | None = None) -> str:
    data = {
        "grant_type": "password",
        "client_id": client_id,
        "username": "dev",
        "password": "dev",
        "scope": "openid",
    }
    if secret:
        data["client_secret"] = secret
    response = httpx.post(TOKEN_URL, data=data, timeout=10)
    response.raise_for_status()
    return response.json()["access_token"]


def tool(client: httpx.Client, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    response = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
        headers=MCP_HEADERS,
    )
    response.raise_for_status()
    text = response.text
    envelope = (
        json.loads([line[5:] for line in text.splitlines() if line.startswith("data:")][-1])
        if "text/event-stream" in response.headers.get("content-type", "")
        else response.json()
    )
    result = envelope["result"]
    check(f"mcp {name} succeeded", not result.get("isError"), result)
    return result["structuredContent"]


def main() -> None:
    app = httpx.Client(
        base_url=BASE, headers={"Authorization": f"Bearer {token('daily2-app')}"}, timeout=20
    )
    claude = httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token('daily2-mcp', 'dev-mcp-secret')}"},
        timeout=20,
    )
    anonymous = httpx.Client(base_url=BASE, timeout=20)

    check("health is ok", anonymous.get("/health").json().get("status") == "ok")
    check("REST without a token is 401", anonymous.get("/api/v2/views/today").status_code == 401)
    check(
        "REST with the MCP client's token is 403",
        claude.get("/api/v2/views/today").status_code == 403,
    )

    context = tool(claude, "get_context", {"date": "2026-09-30"})
    check("get_context returns the day", context["day"]["summary"]["day"] == "2026-09-30")

    food = rest(
        app,
        "POST",
        "/api/v2/commands/save_food",
        "save_food",
        json={"name": "E2E Skyr", "per_100": {"kcal": 62, "protein_g": 11}},
    )["result"]
    breakfast = tool(
        claude,
        "log_events",
        {
            "events": [
                {
                    "kind": "intake",
                    "occurred_at": "2026-09-30T08:00:00+02:00",
                    "payload": {
                        "items": [{"food_id": food["id"], "grams": 250}],
                        "slot": "breakfast",
                    },
                }
            ]
        },
    )["result"]["events"][0]
    check(
        "breakfast logged by claude",
        breakfast["source"] == "claude" and breakfast["payload"]["nutrients"]["kcal"] == 155,
    )

    symptom = tool(
        claude,
        "log_events",
        {
            "events": [
                {
                    "kind": "symptom",
                    "occurred_at": "2026-09-30T10:00:00+02:00",
                    "payload": {"type": "bloated", "severity": 3},
                    "links": [{"to_chain": breakfast["chain_id"], "relation": "suspected_cause"}],
                }
            ]
        },
    )["result"]["events"][0]
    check("symptom linked to breakfast", symptom["links"][0]["chain_id"] == breakfast["chain_id"])

    corrected = tool(
        claude,
        "correct_event",
        {
            "id": breakfast["id"],
            "payload": {"items": [{"food_id": food["id"], "grams": 300}], "slot": "breakfast"},
        },
    )["result"]
    check("breakfast corrected to version 2", corrected["version"] == 2)

    diary = rest(app, "GET", "/api/v2/views/diary", "diary", params={"days": 1})
    day_events = {e["chain_id"]: e for d in diary["days"] for e in d["events"]}
    check(
        "diary shows the corrected head",
        day_events.get(breakfast["chain_id"], {})
        .get("payload", {})
        .get("items", [{}])[0]
        .get("grams")
        == 300,
        diary,
    )

    history = rest(
        app, "GET", "/api/v2/views/event", "event", params={"chain_id": breakfast["chain_id"]}
    )
    check("history keeps both versions", [v["version"] for v in history["versions"]] == [1, 2])

    day = rest(
        app, "GET", "/api/v2/views/day", "day before retraction", params={"date": "2026-09-30"}
    )
    bloated = [s for s in day["summary"]["symptoms"] if s.get("type") == "bloated"]
    check(
        "summary lists the symptom",
        len(bloated) == 1 and bloated[0].get("count") == 1,
        day["summary"]["symptoms"],
    )

    tool(claude, "retract_event", {"id": symptom["id"], "reason": "e2e"})
    day = rest(app, "GET", "/api/v2/views/day", "day", params={"date": "2026-09-30"})
    check(
        "retracted symptom no longer counts",
        day["summary"]["symptoms"] == [],
        day["summary"]["symptoms"],
    )

    tool(claude, "retract_event", {"id": corrected["id"], "reason": "e2e cleanup"})
    print("All checks passed.")


if __name__ == "__main__":
    main()
