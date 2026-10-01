"""Journal tables and the journal's own input/output models."""

import uuid
from datetime import date, datetime
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator
from sqlalchemy.orm import Mapped, mapped_column

from app.features.journal.payloads import EventDraft, Kind, Relation
from app.helpers.database import Base
from app.helpers.models import CommandInput, QueryInput, UtcDatetime


class Event(Base):
    """One version of a fact. A chain is all versions of one fact; exactly one is its head."""

    __tablename__ = "event"
    __table_args__ = (
        sa.Index(
            "uq_event_chain_head", "chain_id", unique=True, postgresql_where=sa.text("is_head")
        ),
        sa.Index(
            "uq_event_external_head",
            "external_source",
            "external_id",
            unique=True,
            postgresql_where=sa.text("is_head AND external_id IS NOT NULL"),
        ),
        sa.Index("ix_event_day_kind", "local_day", "kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    chain_id: Mapped[uuid.UUID] = mapped_column(index=True)
    supersedes: Mapped[uuid.UUID | None] = mapped_column(sa.ForeignKey("event.id"))
    version: Mapped[int]
    is_head: Mapped[bool] = mapped_column(default=True)
    kind: Mapped[str] = mapped_column(sa.String(32))
    schema_version: Mapped[int]
    occurred_at: Mapped[datetime]
    ends_at: Mapped[datetime | None]
    local_day: Mapped[date]
    payload: Mapped[dict[str, Any]]
    source: Mapped[str] = mapped_column(sa.String(32))
    external_source: Mapped[str | None] = mapped_column(sa.String(64))
    external_id: Mapped[str | None] = mapped_column(sa.String(200))
    content_hash: Mapped[str | None] = mapped_column(sa.String(64))
    recorded_at: Mapped[datetime]
    retracted_at: Mapped[datetime | None]
    retract_reason: Mapped[str | None] = mapped_column(sa.String(500))


class EventLink(Base):
    """A relation between two chains, e.g. symptom → suspected_cause → intake."""

    __tablename__ = "event_link"

    from_chain: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    to_chain: Mapped[uuid.UUID] = mapped_column(primary_key=True)
    relation: Mapped[str] = mapped_column(sa.String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(server_default=sa.func.now())


class LinkOut(BaseModel):
    """A link seen from one chain."""

    chain_id: uuid.UUID
    relation: Relation
    direction: Literal["outgoing", "incoming"]


class EventOut(BaseModel):
    """One event version; the payload is always in its kind's current shape."""

    id: uuid.UUID
    chain_id: uuid.UUID
    version: int
    kind: Kind
    occurred_at: datetime
    ends_at: datetime | None
    local_day: date
    payload: dict[str, Any]
    source: str
    recorded_at: datetime
    retracted: bool
    retract_reason: str | None
    links: list[LinkOut] = Field(default_factory=list)


class LogEvents(CommandInput):
    """Log 1-50 facts; each needs kind, occurred_at (with offset) and payload."""

    events: list[EventDraft] = Field(min_length=1, max_length=50)


class EventsOut(BaseModel):
    """Events in time order."""

    events: list[EventOut]


class CorrectEvent(CommandInput):
    """Replace times and/or payload of the current version; the payload is sent whole."""

    id: uuid.UUID = Field(description="The current version's id (the head).")
    occurred_at: UtcDatetime | None = None
    ends_at: UtcDatetime | None = None
    payload: dict[str, Any] | None = None

    @field_validator("occurred_at", "payload")
    @classmethod
    def _not_null(cls, value: Any, info: ValidationInfo) -> Any:
        if value is None:
            raise ValueError(f"{info.field_name} cannot be null")
        return value

    @model_validator(mode="after")
    def _something(self) -> CorrectEvent:
        if not {"occurred_at", "ends_at", "payload"} & self.model_fields_set:
            raise ValueError("send occurred_at, ends_at or payload")
        return self


class RetractEvent(CommandInput):
    """Stop a chain from counting; history keeps it."""

    id: uuid.UUID = Field(description="The current version's id (the head).")
    reason: str | None = Field(default=None, max_length=500)


class LinkEvents(CommandInput):
    """Relate two chains."""

    from_chain: uuid.UUID
    to_chain: uuid.UUID
    relation: Relation


class LinkResult(BaseModel):
    """A stored link."""

    from_chain: uuid.UUID
    to_chain: uuid.UUID
    relation: Relation


class QueryEvents(QueryInput):
    """Current versions between two local days (at most 366 days)."""

    from_day: date
    to_day: date
    kinds: list[Kind] | None = None
    include_retracted: bool = False


class ChainQuery(QueryInput):
    """One chain."""

    chain_id: uuid.UUID


class EventHistory(BaseModel):
    """Every version of a chain, oldest first, with its links."""

    chain_id: uuid.UUID
    kind: Kind
    versions: list[EventOut]
    links: list[LinkOut]


class ExternalDraft(BaseModel):
    """A fact from an external source, identified by the source's own id."""

    external_id: str = Field(min_length=1, max_length=200)
    content_hash: str = Field(min_length=1, max_length=64)
    kind: Kind
    occurred_at: UtcDatetime
    ends_at: UtcDatetime | None = None
    payload: dict[str, Any]
