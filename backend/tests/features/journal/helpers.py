"""Small builders for journal tests."""

from typing import Any

import httpx

AT = "2026-09-30T08:00:00+02:00"


async def food(
    rest: httpx.AsyncClient,
    name: str = "Skyr",
    kcal: float = 62,
    protein: float = 11,
    kind: str = "food",
) -> dict[str, Any]:
    body = {"name": name, "kind": kind, "per_100": {"kcal": kcal, "protein_g": protein}}
    return (await rest.post("/api/v2/commands/save_food", json=body)).json()["result"]


def draft(
    kind: str, payload: dict[str, Any], occurred_at: str = AT, **extra: Any
) -> dict[str, Any]:
    return {"kind": kind, "occurred_at": occurred_at, "payload": payload, **extra}


async def log(rest: httpx.AsyncClient, *drafts: dict[str, Any], **extra: Any) -> httpx.Response:
    return await rest.post("/api/v2/commands/log_events", json={"events": list(drafts), **extra})


async def logged(rest: httpx.AsyncClient, *drafts: dict[str, Any]) -> list[dict[str, Any]]:
    response = await log(rest, *drafts)
    assert response.status_code == 200, response.json()
    return response.json()["result"]["events"]
