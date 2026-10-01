"""Sync bookkeeping and the integration feature's own models."""

from datetime import datetime
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel, Field
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base
from app.helpers.models import CommandInput


class SyncState(Base):
    """Where each source's sync stands."""

    __tablename__ = "sync_state"

    source: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    cursor: Mapped[str | None] = mapped_column(sa.Text)
    last_attempt_at: Mapped[datetime | None]
    last_success_at: Mapped[datetime | None]
    last_error: Mapped[str | None] = mapped_column(sa.String(500))
    last_counts: Mapped[dict[str, Any]] = mapped_column(default=dict)


class SyncStatusOut(BaseModel):
    """A source's sync status and the counts of its last successful run."""

    source: str
    configured: bool
    last_attempt_at: datetime | None
    last_success_at: datetime | None
    last_error: str | None
    counts: dict[str, int]


class SyncNow(CommandInput):
    """Run one source's sync immediately."""

    source: str = Field(min_length=1, max_length=64, description="e.g. gym-bro")
