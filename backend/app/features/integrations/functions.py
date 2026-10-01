"""Running an adapter: fetch without holding a lock, then apply under one."""

import zlib
from datetime import date

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.integrations.adapters import SourceAdapter, configured_adapters
from app.features.integrations.exceptions import UnknownSource
from app.features.integrations.models import SyncNow, SyncState, SyncStatusOut
from app.features.journal.functions import retract_missing, upsert_external
from app.helpers.config import Settings
from app.helpers.database import try_advisory_xact_lock
from app.helpers.endpoints import Context
from app.helpers.errors import AppError, Upstream
from app.helpers.logging import get_logger
from app.helpers.responses import Outcome

logger = get_logger("integrations")

_LOCK_BASE = 0x6461696C
COUNT_KEYS = ("created", "corrected", "unchanged", "retracted", "invalid")


def _lock_key(source: str) -> int:
    return _LOCK_BASE ^ zlib.crc32(source.encode())


def _status(source: str, configured: bool, state: SyncState | None) -> SyncStatusOut:
    return SyncStatusOut(
        source=source,
        configured=configured,
        last_attempt_at=state.last_attempt_at if state else None,
        last_success_at=state.last_success_at if state else None,
        last_error=state.last_error if state else None,
        counts=dict(state.last_counts) if state and state.last_counts else {},
    )


async def _state(session: AsyncSession, source: str) -> SyncState:
    state = await session.get(SyncState, source)
    if state is None:
        state = SyncState(source=source, last_counts={})
        session.add(state)
    return state


async def run_adapter(ctx: Context, adapter: SourceAdapter) -> tuple[SyncStatusOut, set[date]]:
    """One sync: a failed fetch changes no data; a concurrent run is skipped.

    A skipped (locked) run returns the previous status unchanged.
    """
    cursor = await ctx.session.scalar(
        select(SyncState.cursor).where(SyncState.source == adapter.name)
    )
    try:
        result = await adapter.fetch(cursor, ctx.now)
    except Upstream as exc:
        state = await _state(ctx.session, adapter.name)
        state.last_attempt_at = ctx.now
        state.last_error = exc.message[:500]
        await ctx.session.flush()
        return _status(adapter.name, True, state), set()
    except Exception as exc:
        state = await _state(ctx.session, adapter.name)
        state.last_attempt_at = ctx.now
        logger.error(
            "unexpected fetch error", exc_info=True, extra={"context": {"source": adapter.name}}
        )
        state.last_error = f"unexpected error: {type(exc).__name__}"
        await ctx.session.flush()
        return _status(adapter.name, True, state), set()
    if not await try_advisory_xact_lock(ctx.session, _lock_key(adapter.name)):
        return _status(adapter.name, True, await ctx.session.get(SyncState, adapter.name)), set()
    state = await _state(ctx.session, adapter.name)
    state.last_attempt_at = ctx.now
    counts = dict.fromkeys(COUNT_KEYS, 0)
    counts["invalid"] = result.invalid
    days: set[date] = set()
    for draft in result.drafts:
        try:
            outcome, touched = await upsert_external(ctx, adapter.name, draft)
        except (AppError, ValidationError) as exc:
            counts["invalid"] += 1
            logger.warning(
                "skipped an invalid item",
                extra={
                    "context": {"source": adapter.name, "id": draft.external_id, "error": str(exc)}
                },
            )
            continue
        counts[outcome] += 1
        days |= touched
    if adapter.authoritative and result.covered_since is not None:
        retracted, removed_days = await retract_missing(
            ctx,
            adapter.name,
            result.covered_since,
            result.seen_ids | {d.external_id for d in result.drafts},
        )
        counts["retracted"] = retracted
        days |= removed_days
    state.cursor = result.cursor
    state.last_success_at = ctx.now
    state.last_error = None
    state.last_counts = counts
    await ctx.session.flush()
    return _status(adapter.name, True, state), days


async def sync_status(session: AsyncSession, settings: Settings) -> list[SyncStatusOut]:
    """Every configured source's status, plus previously synced sources no longer configured."""
    configured = configured_adapters(settings)
    states = {s.source: s for s in await session.scalars(select(SyncState))}
    names = sorted(set(configured) | set(states))
    return [_status(name, name in configured, states.get(name)) for name in names]


async def sync_now(ctx: Context, data: SyncNow) -> Outcome[SyncStatusOut]:
    """Run one configured source now."""
    adapter = configured_adapters(ctx.settings).get(data.source)
    if adapter is None:
        raise UnknownSource(data.source)
    status, days = await run_adapter(ctx, adapter)
    warnings = [f"{data.source} sync failed: {status.last_error}"] if status.last_error else []
    return Outcome(status, days=days, warnings=warnings)
