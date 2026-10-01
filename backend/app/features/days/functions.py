"""Composing days: load events, profile, weight and sync status, then summarise."""

from datetime import date, timedelta

from app.features.days.calculations import context_warnings, summarize, weight_trend
from app.features.days.exceptions import InvalidCursor
from app.features.days.models import (
    ContextOut,
    ContextQuery,
    DayQuery,
    DayView,
    Diary,
    DiaryDay,
    DiaryQuery,
    ProfileView,
    WeightInfo,
)
from app.features.integrations.functions import sync_status
from app.features.journal.functions import (
    days_with_events,
    heads_between,
    latest_measurement,
    measurements,
)
from app.features.journal.models import EventOut
from app.features.profile.functions import (
    current_profile,
    list_source_preferences,
    preferred_sources,
    profile_for,
    timezone_at,
)
from app.helpers.endpoints import Context
from app.helpers.errors import ValidationFailed
from app.helpers.models import EmptyQuery, decode_cursor, encode_cursor
from app.helpers.time import day_bounds, local_day, to_local

TREND_DAYS = 14
RECENT_SYMPTOM_DAYS = 3


async def _today(ctx: Context) -> tuple[date, str]:
    timezone = await timezone_at(ctx.session, ctx.now, ctx.settings.default_timezone)
    return local_day(ctx.now, timezone), timezone


async def _day_view(ctx: Context, day: date, timezone: str) -> tuple[DayView, EventOut | None]:
    """A day's view and latest weight; sleep counts on the day it ended."""
    events = await heads_between(ctx.session, day - timedelta(days=1), day)
    timeline = [e for e in events if e.local_day == day]
    sleeps = [
        e
        for e in events
        if e.kind == "sleep" and e.ends_at is not None and local_day(e.ends_at, timezone) == day
    ]
    sleep = max(sleeps, key=lambda e: e.ends_at - e.occurred_at, default=None)
    end_of_day = day_bounds(day, timezone)[1] - timedelta(microseconds=1)
    profile = await profile_for(ctx.session, end_of_day)
    weight = await latest_measurement(ctx.session, "weight_kg", day)
    preference = (await preferred_sources(ctx.session)).get("steps", [])
    summary = summarize(
        day, timeline, sleep, weight.payload["value"] if weight else None, profile, preference
    )
    return DayView(summary=summary, timeline=timeline), weight


async def get_day(ctx: Context, data: DayQuery) -> DayView:
    """One local day: summary with the four gauges, and its timeline."""
    _, timezone = await _today(ctx)
    return (await _day_view(ctx, data.date, timezone))[0]


async def get_context(ctx: Context, data: ContextQuery) -> ContextOut:
    """The whole picture for a day (default today) in one call."""
    today, timezone = await _today(ctx)
    day = data.date or today
    view, latest = await _day_view(ctx, day, timezone)
    series = await measurements(ctx.session, "weight_kg", day - timedelta(days=TREND_DAYS - 1), day)
    weight = WeightInfo(
        latest_kg=latest.payload["value"] if latest else None,
        latest_day=latest.local_day if latest else None,
        trend_kg_per_week=weight_trend([(e.local_day, e.payload["value"]) for e in series]),
    )
    symptoms = await heads_between(
        ctx.session, day - timedelta(days=RECENT_SYMPTOM_DAYS - 1), day, ["symptom"]
    )
    integrations = await sync_status(ctx.session, ctx.settings)
    warnings = context_warnings(
        today=today,
        day=day,
        local_now=to_local(ctx.now, timezone),
        summary=view.summary,
        timeline=view.timeline,
        latest_weight_day=weight.latest_day,
        integration_errors=[(s.source, s.last_error) for s in integrations if s.last_error],
    )
    return ContextOut(
        today=today,
        day=view,
        weight=weight,
        recent_symptoms=symptoms,
        integrations=integrations,
        warnings=warnings,
    )


def _before(cursor: str | None) -> date | None:
    if cursor is None:
        return None
    try:
        return date.fromisoformat(decode_cursor(cursor)["before"])
    except (ValidationFailed, KeyError, TypeError, ValueError) as exc:
        raise InvalidCursor() from exc


async def get_diary(ctx: Context, data: DiaryQuery) -> Diary:
    """Whole days with events, newest first; events within a day in time order."""
    days = await days_with_events(ctx.session, _before(data.cursor), data.days, data.kinds)
    if not days:
        return Diary(days=[], next_cursor=None)
    events = await heads_between(ctx.session, days[-1], days[0], data.kinds)
    grouped: dict[date, list] = {day: [] for day in days}
    for event in events:
        if event.local_day in grouped:
            grouped[event.local_day].append(event)
    next_cursor = (
        encode_cursor({"before": days[-1].isoformat()}) if len(days) == data.days else None
    )
    return Diary(
        days=[DiaryDay(day=day, events=grouped[day]) for day in days], next_cursor=next_cursor
    )


async def get_profile(ctx: Context, data: EmptyQuery) -> ProfileView:
    """The profile with today's targets, source preferences and integration status."""
    today, timezone = await _today(ctx)
    view, _ = await _day_view(ctx, today, timezone)
    return ProfileView(
        profile=await current_profile(ctx.session, ctx.now),
        targets_today=view.summary.targets,
        source_preferences=await list_source_preferences(ctx.session),
        integrations=await sync_status(ctx.session, ctx.settings),
    )
