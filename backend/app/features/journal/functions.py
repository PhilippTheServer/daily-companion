"""Journal logic: append facts, correct and retract chains, link them, read them back."""

import uuid
from collections.abc import Sequence
from datetime import date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ValidationError
from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.catalog.functions import recipe_items, snapshot
from app.features.journal.exceptions import (
    EndBeforeStart,
    EndForbidden,
    EndRequired,
    EventNotFound,
    EventRetracted,
    InvalidRange,
    LinkNotFound,
    SelfLink,
    StaleHead,
)
from app.features.journal.models import (
    ChainQuery,
    CorrectEvent,
    Event,
    EventHistory,
    EventLink,
    EventOut,
    EventsOut,
    ExternalDraft,
    LinkEvents,
    LinkOut,
    LinkResult,
    LogEvents,
    QueryEvents,
    RetractEvent,
)
from app.features.journal.payloads import (
    KINDS,
    IntakeIn,
    IntakeItemStored,
    IntakeStored,
    current_payload,
)
from app.features.profile.functions import timezone_at
from app.helpers.endpoints import Context
from app.helpers.errors import from_validation_errors
from app.helpers.models import Nutrients
from app.helpers.responses import Outcome
from app.helpers.time import local_day

MAX_RANGE_DAYS = 366


def _check_times(kind: str, occurred_at: datetime, ends_at: datetime | None, prefix: str) -> None:
    rule = KINDS[kind].ends
    if rule == "required" and ends_at is None:
        raise EndRequired(kind, prefix)
    if rule == "forbidden" and ends_at is not None:
        raise EndForbidden(kind, prefix)
    if ends_at is not None and ends_at < occurred_at:
        raise EndBeforeStart(prefix)


def _validate(kind: str, raw: dict[str, Any], field: str) -> BaseModel:
    try:
        return KINDS[kind].input.model_validate(raw)
    except ValidationError as exc:
        raise from_validation_errors(list(exc.errors()), field) from exc


async def _stored_payload(
    session: AsyncSession, kind: str, payload: BaseModel, field: str
) -> dict[str, Any]:
    """The payload as stored; an intake is resolved and its nutrients snapshotted."""
    if not isinstance(payload, IntakeIn):
        return payload.model_dump(mode="json")
    portions = payload.portions
    recipe_version_id = None
    if payload.recipe_id is not None:
        portions = portions or 1
        recipe_version_id, pairs = await recipe_items(
            session, payload.recipe_id, portions, f"{field}.recipe_id"
        )
    else:
        pairs = [(item.food_id, item.grams) for item in payload.items]
    items = await snapshot(session, pairs, f"{field}.items")
    stored = IntakeStored(
        slot=payload.slot,
        items=[IntakeItemStored(**item.model_dump(exclude={"kind"})) for item in items],
        recipe_id=payload.recipe_id,
        recipe_version_id=recipe_version_id,
        portions=portions,
        note=payload.note,
        nutrients=Nutrients.total(item.nutrients for item in items),
    )
    return stored.model_dump(mode="json")


async def _insert(
    ctx: Context,
    *,
    kind: str,
    occurred_at: datetime,
    ends_at: datetime | None,
    payload: dict[str, Any],
    source: str,
    previous: Event | None = None,
    external: tuple[str, str, str] | None = None,
) -> Event:
    """Add a new version: a new chain, or the successor of `previous`."""
    timezone = await timezone_at(ctx.session, occurred_at, ctx.settings.default_timezone)
    event_id = uuid.uuid4()
    external_source, external_id, content_hash = external or (None, None, None)
    event = Event(
        id=event_id,
        chain_id=previous.chain_id if previous else event_id,
        supersedes=previous.id if previous else None,
        version=previous.version + 1 if previous else 1,
        is_head=True,
        kind=kind,
        schema_version=KINDS[kind].version,
        occurred_at=occurred_at,
        ends_at=ends_at,
        local_day=local_day(occurred_at, timezone),
        payload=payload,
        source=source,
        external_source=external_source,
        external_id=external_id,
        content_hash=content_hash,
        recorded_at=ctx.now,
    )
    ctx.session.add(event)
    return event


async def _links(
    session: AsyncSession, chain_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[LinkOut]]:
    result: dict[uuid.UUID, list[LinkOut]] = {chain_id: [] for chain_id in chain_ids}
    if not chain_ids:
        return result
    rows = await session.scalars(
        select(EventLink)
        .where(or_(EventLink.from_chain.in_(chain_ids), EventLink.to_chain.in_(chain_ids)))
        .order_by(
            EventLink.created_at, EventLink.relation, EventLink.to_chain, EventLink.from_chain
        )
    )
    for link in rows:
        if link.from_chain in result:
            result[link.from_chain].append(
                LinkOut(chain_id=link.to_chain, relation=link.relation, direction="outgoing")
            )
        if link.to_chain in result:
            result[link.to_chain].append(
                LinkOut(chain_id=link.from_chain, relation=link.relation, direction="incoming")
            )
    return result


def _out(event: Event, links: list[LinkOut] | None = None) -> EventOut:
    return EventOut(
        id=event.id,
        chain_id=event.chain_id,
        version=event.version,
        kind=event.kind,
        occurred_at=event.occurred_at,
        ends_at=event.ends_at,
        local_day=event.local_day,
        payload=current_payload(event.kind, event.schema_version, event.payload),
        source=event.source,
        recorded_at=event.recorded_at,
        retracted=event.retracted_at is not None,
        retract_reason=event.retract_reason,
        links=links or [],
    )


async def _outs(session: AsyncSession, events: Sequence[Event]) -> list[EventOut]:
    links = await _links(session, list({event.chain_id for event in events}))
    return [_out(event, links[event.chain_id]) for event in events]


async def _head(session: AsyncSession, event_id: uuid.UUID) -> Event:
    event = await session.scalar(
        select(Event)
        .where(Event.id == event_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if event is None:
        raise EventNotFound(event_id)
    if not event.is_head:
        head_id = await session.scalar(
            select(Event.id).where(Event.chain_id == event.chain_id, Event.is_head)
        )
        raise StaleHead(event_id, head_id)
    return event


async def _chain_head(session: AsyncSession, chain_id: uuid.UUID, field: str) -> Event:
    head = await session.scalar(select(Event).where(Event.chain_id == chain_id, Event.is_head))
    if head is None:
        raise EventNotFound(chain_id, field)
    return head


async def _add_link(
    session: AsyncSession, from_chain: uuid.UUID, to_chain: uuid.UUID, relation: str
) -> None:
    await session.execute(
        insert(EventLink)
        .values(from_chain=from_chain, to_chain=to_chain, relation=relation)
        .on_conflict_do_nothing()
    )


async def log_events(ctx: Context, data: LogEvents) -> Outcome[EventsOut]:
    """Append each draft as a new chain, then its links."""
    created = []
    for index, draft in enumerate(data.events):
        prefix = f"events.{index}"
        _check_times(draft.kind, draft.occurred_at, draft.ends_at, prefix)
        payload = await _stored_payload(ctx.session, draft.kind, draft.payload, f"{prefix}.payload")
        created.append(
            await _insert(
                ctx,
                kind=draft.kind,
                occurred_at=draft.occurred_at,
                ends_at=draft.ends_at,
                payload=payload,
                source=ctx.principal.source,
            )
        )
    await ctx.session.flush()
    for index, draft in enumerate(data.events):
        for link_index, link in enumerate(draft.links):
            field = f"events.{index}.links.{link_index}.to_chain"
            if link.to_chain == created[index].chain_id:
                raise SelfLink(field)
            await _chain_head(ctx.session, link.to_chain, field)
            await _add_link(ctx.session, created[index].chain_id, link.to_chain, link.relation)
    return Outcome(
        EventsOut(events=await _outs(ctx.session, created)), days={e.local_day for e in created}
    )


async def correct_event(ctx: Context, data: CorrectEvent) -> Outcome[EventOut]:
    """Write the next version of a chain with new times and/or a new payload."""
    old = await _head(ctx.session, data.id)
    if old.retracted_at is not None:
        raise EventRetracted(old.chain_id)
    sent = data.model_fields_set
    occurred_at = data.occurred_at if data.occurred_at is not None else old.occurred_at
    ends_at = data.ends_at if "ends_at" in sent else old.ends_at
    _check_times(old.kind, occurred_at, ends_at, "")
    if data.payload is not None:
        payload = await _stored_payload(
            ctx.session, old.kind, _validate(old.kind, data.payload, "payload"), "payload"
        )
    else:
        payload = current_payload(old.kind, old.schema_version, old.payload)
    old.is_head = False
    await ctx.session.flush()
    external = (old.external_source, old.external_id, old.content_hash) if old.external_id else None
    new = await _insert(
        ctx,
        kind=old.kind,
        occurred_at=occurred_at,
        ends_at=ends_at,
        payload=payload,
        source=ctx.principal.source,
        previous=old,
        external=external,
    )
    await ctx.session.flush()
    return Outcome((await _outs(ctx.session, [new]))[0], days={old.local_day, new.local_day})


async def retract_event(ctx: Context, data: RetractEvent) -> Outcome[EventOut]:
    """Mark a chain as not counting; retracting twice changes nothing."""
    head = await _head(ctx.session, data.id)
    if head.retracted_at is None:
        head.retracted_at = ctx.now
        head.retract_reason = data.reason
        await ctx.session.flush()
    return Outcome((await _outs(ctx.session, [head]))[0], days={head.local_day})


async def link_events(ctx: Context, data: LinkEvents) -> Outcome[LinkResult]:
    """Relate two chains; linking twice changes nothing."""
    if data.from_chain == data.to_chain:
        raise SelfLink()
    source = await _chain_head(ctx.session, data.from_chain, "from_chain")
    target = await _chain_head(ctx.session, data.to_chain, "to_chain")
    await _add_link(ctx.session, data.from_chain, data.to_chain, data.relation)
    result = LinkResult(from_chain=data.from_chain, to_chain=data.to_chain, relation=data.relation)
    return Outcome(result, days={source.local_day, target.local_day})


async def unlink_events(ctx: Context, data: LinkEvents) -> Outcome[LinkResult]:
    """Remove a link."""
    result = await ctx.session.execute(
        delete(EventLink).where(
            EventLink.from_chain == data.from_chain,
            EventLink.to_chain == data.to_chain,
            EventLink.relation == data.relation,
        )
    )
    if result.rowcount == 0:
        raise LinkNotFound()
    return Outcome(
        LinkResult(from_chain=data.from_chain, to_chain=data.to_chain, relation=data.relation)
    )


def _check_range(from_day: date, to_day: date) -> None:
    if to_day < from_day:
        raise InvalidRange("to_day is before from_day")
    if (to_day - from_day) >= timedelta(days=MAX_RANGE_DAYS):
        raise InvalidRange(f"a range covers at most {MAX_RANGE_DAYS} days")


async def heads_between(
    session: AsyncSession,
    from_day: date,
    to_day: date,
    kinds: Sequence[str] | None = None,
    include_retracted: bool = False,
) -> list[EventOut]:
    """Current versions whose local day lies in the range, in time order."""
    statement = (
        select(Event)
        .where(Event.is_head, Event.local_day.between(from_day, to_day))
        .order_by(Event.occurred_at, Event.id)
    )
    if kinds:
        statement = statement.where(Event.kind.in_(kinds))
    if not include_retracted:
        statement = statement.where(Event.retracted_at.is_(None))
    return await _outs(session, (await session.scalars(statement)).all())


async def query_events(ctx: Context, data: QueryEvents) -> EventsOut:
    """Current versions between two local days, optionally of some kinds."""
    _check_range(data.from_day, data.to_day)
    return EventsOut(
        events=await heads_between(
            ctx.session, data.from_day, data.to_day, data.kinds, data.include_retracted
        )
    )


async def get_event_history(ctx: Context, data: ChainQuery) -> EventHistory:
    """Every version of a chain, oldest first, with its links."""
    rows = (
        await ctx.session.scalars(
            select(Event).where(Event.chain_id == data.chain_id).order_by(Event.version)
        )
    ).all()
    if not rows:
        raise EventNotFound(data.chain_id, "chain_id")
    links = (await _links(ctx.session, [data.chain_id]))[data.chain_id]
    return EventHistory(
        chain_id=data.chain_id,
        kind=rows[0].kind,
        versions=[_out(row, links) for row in rows],
        links=links,
    )


REMOVED_AT_SOURCE = "removed at source"


def _measurement_statement(metric: str):
    return select(Event).where(
        Event.is_head,
        Event.retracted_at.is_(None),
        Event.kind == "measurement",
        Event.payload["metric"].astext == metric,
    )


async def latest_measurement(
    session: AsyncSession, metric: str, on_or_before: date
) -> EventOut | None:
    """The newest value of a metric on or before a local day."""
    row = await session.scalar(
        _measurement_statement(metric)
        .where(Event.local_day <= on_or_before)
        .order_by(Event.occurred_at.desc())
        .limit(1)
    )
    return _out(row) if row else None


async def measurements(
    session: AsyncSession, metric: str, from_day: date, to_day: date
) -> list[EventOut]:
    """A metric's values between two local days, in time order."""
    rows = await session.scalars(
        _measurement_statement(metric)
        .where(Event.local_day.between(from_day, to_day))
        .order_by(Event.occurred_at)
    )
    return [_out(row) for row in rows]


async def days_with_events(
    session: AsyncSession, before: date | None, limit: int, kinds: Sequence[str] | None = None
) -> list[date]:
    """Local days that have counting events, newest first, strictly before `before`."""
    statement = (
        select(Event.local_day)
        .where(Event.is_head, Event.retracted_at.is_(None))
        .distinct()
        .order_by(Event.local_day.desc())
        .limit(limit)
    )
    if before is not None:
        statement = statement.where(Event.local_day < before)
    if kinds:
        statement = statement.where(Event.kind.in_(kinds))
    return list((await session.scalars(statement)).all())


async def upsert_external(
    ctx: Context, source: str, draft: ExternalDraft
) -> tuple[Literal["created", "corrected", "unchanged"], set[date]]:
    """Create or correct the chain for a source's id.

    A chain the owner retracted stays retracted whatever the source sends. Only a retraction
    for REMOVED_AT_SOURCE is undone when the item reappears, with the same or a changed hash.
    """
    head = await ctx.session.scalar(
        select(Event)
        .where(
            Event.external_source == source,
            Event.external_id == draft.external_id,
            Event.is_head,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if head is not None:
        if head.retracted_at is None:
            if head.content_hash == draft.content_hash:
                return "unchanged", set()
        elif head.retract_reason != REMOVED_AT_SOURCE:
            return "unchanged", set()
    _check_times(draft.kind, draft.occurred_at, draft.ends_at, "")
    payload = await _stored_payload(
        ctx.session, draft.kind, _validate(draft.kind, draft.payload, "payload"), "payload"
    )
    if head is not None:
        head.is_head = False
        await ctx.session.flush()
    event = await _insert(
        ctx,
        kind=draft.kind,
        occurred_at=draft.occurred_at,
        ends_at=draft.ends_at,
        payload=payload,
        source=source,
        previous=head,
        external=(source, draft.external_id, draft.content_hash),
    )
    await ctx.session.flush()
    if head is None:
        return "created", {event.local_day}
    return "corrected", {head.local_day, event.local_day}


async def retract_missing(
    ctx: Context, source: str, since: datetime, seen: set[str]
) -> tuple[int, set[date]]:
    """Retract the source's counting chains from `since` on that the source no longer returns."""
    rows = await ctx.session.scalars(
        select(Event)
        .where(
            Event.external_source == source,
            Event.is_head,
            Event.retracted_at.is_(None),
            Event.occurred_at >= since,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    count = 0
    days: set[date] = set()
    for event in rows:
        if event.external_id not in seen:
            event.retracted_at = ctx.now
            event.retract_reason = REMOVED_AT_SOURCE
            count += 1
            days.add(event.local_day)
    await ctx.session.flush()
    return count, days
