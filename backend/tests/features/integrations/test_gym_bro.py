from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.features.integrations.adapters import GymBroAdapter, workout_draft
from app.features.integrations.services import GymBroClient
from app.helpers.auth import ClientCredentials
from app.helpers.errors import Upstream

SESSION = {
    "id": "6f1c1a52-0000-0000-0000-000000000001",
    "name": "Push A",
    "started_at": "2026-09-28T17:00:00+00:00",
    "completed_at": "2026-09-28T17:31:00+00:00",
    "exercises": [
        {
            "order": 1,
            "exercise": {"name": "Bench", "category": None, "muscle_group": "chest"},
            "sets": [
                {
                    "order": 1,
                    "completed": True,
                    "set_type": "working_set",
                    "weight": 80,
                    "reps": 8,
                    "duration_seconds": None,
                    "rpe": 8,
                },
                {
                    "order": 2,
                    "completed": False,
                    "set_type": "working_set",
                    "weight": 80,
                    "reps": 8,
                    "duration_seconds": None,
                    "rpe": None,
                },
            ],
        },
        {
            "order": 0,
            "exercise": {"name": "Rower", "category": None, "muscle_group": "cardio"},
            "sets": [
                {
                    "order": 1,
                    "completed": True,
                    "set_type": "working_set",
                    "weight": None,
                    "reps": None,
                    "duration_seconds": 600,
                    "rpe": 6,
                },
            ],
        },
    ],
}


def test_workout_draft_maps_completed_sets_and_categories():
    draft = workout_draft(SESSION)
    assert (draft.external_id, draft.kind) == (SESSION["id"], "workout")
    assert draft.payload["category"] == "mixed"
    assert draft.payload["set_count"] == 2
    assert draft.payload["volume_kg"] == 640
    assert [e["name"] for e in draft.payload["exercises"]] == ["Rower", "Bench"]
    assert draft.payload["exercises"][1]["sets"] == [
        {"reps": 8, "weight_kg": 80, "duration_s": None, "rpe": 8}
    ]


def test_content_hash_is_stable_and_changes_with_content():
    assert workout_draft(SESSION).content_hash == workout_draft(SESSION).content_hash
    heavier = {**SESSION, "name": "Push B"}
    assert workout_draft(heavier).content_hash != workout_draft(SESSION).content_hash


async def test_client_pages_with_a_service_token():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "svc", "expires_in": 300})
        assert request.headers["authorization"] == "Bearer svc"
        offset = int(request.url.params["offset"])
        seen.append(offset)
        return httpx.Response(200, json=[SESSION] * (100 if offset == 0 else 1))

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = GymBroClient(
        http, "http://gym", ClientCredentials("http://kc/token", "svc", "s", http)
    )
    sessions = await client.completed_sessions("owner", datetime(2026, 9, 1, tzinfo=UTC))
    assert (len(sessions), seen) == (101, [0, 100])
    await client.aclose()


async def test_client_failures_are_upstream():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "svc", "expires_in": 300})
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = GymBroClient(
        http, "http://gym", ClientCredentials("http://kc/token", "svc", "s", http)
    )
    with pytest.raises(Upstream):
        await client.completed_sessions("owner", datetime(2026, 9, 1, tzinfo=UTC))


class _RecordingClient:
    def __init__(self) -> None:
        self.completed_after: list[datetime] = []

    async def completed_sessions(self, owner_sub, since):
        self.completed_after.append(since)
        return []


async def test_fetch_starts_at_an_old_cursor_and_at_the_window_for_a_recent_one():
    now = datetime(2026, 9, 29, 12, tzinfo=UTC)
    client = _RecordingClient()
    adapter = GymBroAdapter(client, "owner", 3600)
    old = now - timedelta(days=30)
    result = await adapter.fetch(old.isoformat(), now)
    assert (client.completed_after[-1], result.covered_since) == (old, old)
    recent = await adapter.fetch((now - timedelta(hours=1)).isoformat(), now)
    assert client.completed_after[-1] == now - adapter.window == recent.covered_since
