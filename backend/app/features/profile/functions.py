"""Profile logic: versioned updates, the timezone at a moment, and source preferences."""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.profile.exceptions import FieldRequired, GoalIncomplete
from app.features.profile.models import (
    PROFILE_FIELDS,
    REQUIRED_FIELDS,
    ProfileOut,
    ProfileUpdate,
    ProfileVersion,
    SourcePreference,
    SourcePreferenceIn,
    SourcePreferenceOut,
)
from app.helpers.endpoints import Context
from app.helpers.responses import Outcome
from app.helpers.time import local_day

DEFAULTS = {"protein_g_per_kg": 1.8, "fat_g_per_kg_min": 0.8}


async def profile_at(session: AsyncSession, moment: datetime) -> ProfileVersion | None:
    """The version valid at a moment."""
    return await session.scalar(
        select(ProfileVersion)
        .where(ProfileVersion.valid_from <= moment)
        .order_by(ProfileVersion.valid_from.desc())
        .limit(1)
    )


async def profile_for(session: AsyncSession, moment: datetime) -> ProfileOut | None:
    """The version valid at a moment; before the first version, the first version."""
    row = await profile_at(session, moment)
    if row is None:
        row = await session.scalar(
            select(ProfileVersion).order_by(ProfileVersion.valid_from).limit(1)
        )
    return ProfileOut.model_validate(row) if row else None


async def current_profile(session: AsyncSession, now: datetime) -> ProfileOut | None:
    """The version valid now, as its output model."""
    row = await profile_at(session, now)
    return ProfileOut.model_validate(row) if row else None


async def timezone_at(session: AsyncSession, moment: datetime, default: str) -> str:
    """The owner's timezone at a moment, or the default before any profile exists."""
    row = await profile_at(session, moment)
    return row.timezone if row else default


async def update_profile(ctx: Context, data: ProfileUpdate) -> Outcome[ProfileOut]:
    """Write a new version from the current one plus the fields sent."""
    current = await profile_at(ctx.session, ctx.now)
    if current is not None:
        values = {name: getattr(current, name) for name in PROFILE_FIELDS}
    else:
        values = (
            {name: None for name in PROFILE_FIELDS}
            | {"timezone": ctx.settings.default_timezone}
            | DEFAULTS
        )
    changes = data.model_dump(exclude_unset=True, exclude={"idempotency_key"})
    for name in REQUIRED_FIELDS:
        if name in changes and changes[name] is None:
            raise FieldRequired(name)
    values.update(changes)
    if (values["goal_weight_kg"] is None) != (values["goal_date"] is None):
        raise GoalIncomplete()
    row = ProfileVersion(valid_from=ctx.now, **values)
    ctx.session.add(row)
    await ctx.session.flush()
    return Outcome(ProfileOut.model_validate(row), days={local_day(ctx.now, row.timezone)})


async def preferred_sources(session: AsyncSession) -> dict[str, list[str]]:
    """Every metric's source order."""
    rows = await session.scalars(select(SourcePreference))
    return {row.metric: list(row.sources) for row in rows}


async def list_source_preferences(session: AsyncSession) -> list[SourcePreferenceOut]:
    """Every metric's source order, as output models."""
    return [
        SourcePreferenceOut(metric=m, sources=s)
        for m, s in sorted((await preferred_sources(session)).items())
    ]


async def set_source_preference(
    ctx: Context, data: SourcePreferenceIn
) -> Outcome[SourcePreferenceOut]:
    """Create or replace one metric's source order."""
    row = await ctx.session.get(SourcePreference, data.metric)
    if row is None:
        ctx.session.add(SourcePreference(metric=data.metric, sources=data.sources))
    else:
        row.sources = data.sources
    await ctx.session.flush()
    return Outcome(SourcePreferenceOut(metric=data.metric, sources=data.sources))
