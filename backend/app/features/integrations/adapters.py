"""Source adapters: fetch from an external system and map to ExternalDrafts, nothing more."""

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from pydantic import ValidationError

from app.features.integrations.services import GymBroClient, gym_bro
from app.features.journal.models import ExternalDraft
from app.helpers.config import Settings

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class FetchResult:
    """What one fetch returned, the cursor for next time, and the span it fully covers."""

    drafts: list[ExternalDraft]
    cursor: str
    covered_since: datetime | None
    invalid: int = 0
    seen_ids: set[str] = field(default_factory=set)


class SourceAdapter(Protocol):
    """An external source. `authoritative` sources retract what they stop returning."""

    name: str
    interval_seconds: int
    authoritative: bool

    async def fetch(self, cursor: str | None, now: datetime) -> FetchResult: ...


def _order(item: dict[str, Any]) -> int:
    return int(item.get("order") or 0)


def _category(categories: set[str]) -> str:
    if not categories:
        return "other"
    if categories == {"cardio"}:
        return "cardio"
    return "mixed" if "cardio" in categories else "strength"


def workout_draft(session: dict[str, Any]) -> ExternalDraft:
    """A gym-bro session as a workout event; only completed sets count."""
    exercises = []
    set_count = 0
    volume = 0.0
    categories: set[str] = set()
    for exercise in sorted(session.get("exercises") or [], key=_order):
        info = exercise.get("exercise") or {}
        category = info.get("category") or (
            "cardio" if info.get("muscle_group") == "cardio" else "strength"
        )
        categories.add(category)
        sets = [s for s in sorted(exercise.get("sets") or [], key=_order) if s.get("completed")]
        set_count += len(sets)
        volume += sum(
            s["weight"] * s["reps"]
            for s in sets
            if s.get("weight") is not None and s.get("reps") is not None
        )
        exercises.append(
            {
                "name": info.get("name") or "exercise",
                "category": category,
                "sets": [
                    {
                        "reps": s.get("reps"),
                        "weight_kg": s.get("weight"),
                        "duration_s": s.get("duration_seconds"),
                        "rpe": s.get("rpe"),
                    }
                    for s in sets
                ],
            }
        )
    payload = {
        "title": session.get("name") or "Workout",
        "category": _category(categories),
        "set_count": set_count,
        "volume_kg": round(volume, 1),
        "exercises": exercises,
    }
    fingerprint = json.dumps(
        {
            "payload": payload,
            "started_at": session["started_at"],
            "completed_at": session["completed_at"],
        },
        sort_keys=True,
    )
    return ExternalDraft(
        external_id=str(session["id"]),
        content_hash=hashlib.sha256(fingerprint.encode()).hexdigest(),
        kind="workout",
        occurred_at=session["started_at"],
        ends_at=session["completed_at"],
        payload=payload,
    )


class GymBroAdapter:
    """gym-bro is the source of truth for workouts in the last 14 days."""

    name = "gym-bro"
    authoritative = True
    window = timedelta(days=14)

    def __init__(self, client: GymBroClient, owner_sub: str, interval_seconds: int) -> None:
        self._client = client
        self._owner_sub = owner_sub
        self.interval_seconds = interval_seconds

    async def fetch(self, cursor: str | None, now: datetime) -> FetchResult:
        since = EPOCH if cursor is None else min(datetime.fromisoformat(cursor), now - self.window)
        sessions = await self._client.completed_sessions(self._owner_sub, since)
        drafts: list[ExternalDraft] = []
        seen_ids: set[str] = set()
        invalid = 0
        for session in sessions:
            try:
                seen_ids.add(str(session["id"]))
            except KeyError, TypeError:
                invalid += 1
                continue
            try:
                drafts.append(workout_draft(session))
            except KeyError, TypeError, ValueError, ValidationError:
                invalid += 1
        return FetchResult(
            drafts=drafts,
            cursor=now.isoformat(),
            covered_since=since,
            invalid=invalid,
            seen_ids=seen_ids,
        )


_override: dict[str, SourceAdapter] | None = None


def configured_adapters(settings: Settings) -> dict[str, SourceAdapter]:
    """Every source that is configured, by name."""
    if _override is not None:
        return _override
    adapters: dict[str, SourceAdapter] = {}
    if settings.gym_bro_url and settings.gym_bro_client_secret:
        adapters["gym-bro"] = GymBroAdapter(
            gym_bro(), settings.owner_sub, settings.gym_bro_interval_seconds
        )
    return adapters


def override_adapters(adapters: dict[str, SourceAdapter] | None) -> None:
    """Use these adapters instead of the configured ones (tests); None restores them."""
    global _override
    _override = adapters
