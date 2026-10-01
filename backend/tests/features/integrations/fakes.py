"""A controllable in-memory source."""

from datetime import UTC, datetime

from app.features.integrations.adapters import FetchResult
from app.features.journal.models import ExternalDraft
from app.helpers.errors import Upstream


def workout(
    external_id: str, volume: float = 1000, started: str = "2026-09-28T17:00:00Z"
) -> ExternalDraft:
    return ExternalDraft(
        external_id=external_id,
        content_hash=f"{external_id}-{volume}",
        kind="workout",
        occurred_at=started,
        ends_at="2026-09-28T17:31:00Z",
        payload={"title": "Push", "category": "strength", "volume_kg": volume},
    )


COVERED_SINCE = datetime(2026, 9, 1, tzinfo=UTC)


class FakeAdapter:
    """Returns `drafts`; `fail=True` raises like an unreachable source."""

    name = "fake"
    interval_seconds = 3600
    authoritative = True

    def __init__(self, drafts: list[ExternalDraft] | None = None) -> None:
        self.drafts = drafts or []
        self.fail = False
        self.cursors: list[str | None] = []

    async def fetch(self, cursor: str | None, now: datetime) -> FetchResult:
        self.cursors.append(cursor)
        if self.fail:
            raise Upstream("fake source is down")
        return FetchResult(
            drafts=list(self.drafts), cursor=now.isoformat(), covered_since=COVERED_SINCE
        )
