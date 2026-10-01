"""The days feature's endpoints."""

from app.features.days import functions
from app.features.days.exceptions import InvalidCursor
from app.features.days.models import (
    ContextOut,
    ContextQuery,
    DayQuery,
    DayView,
    Diary,
    DiaryQuery,
    ProfileView,
)
from app.helpers.endpoints import query
from app.helpers.models import EmptyQuery

OPERATIONS = (
    query(
        "get_context",
        ContextQuery,
        ContextOut,
        functions.get_context,
        "START HERE in every conversation. The owner's day (default today): summary with the four "
        "gauges (kcal, protein, carbs, fat vs targets), timeline, latest weight and 14-day trend, "
        "symptoms of the last 3 days, sync status and warnings.",
        view="today",
    ),
    query(
        "get_day",
        DayQuery,
        DayView,
        functions.get_day,
        "One local day: summary with gauges, and its timeline.",
        view="day",
    ),
    query(
        "get_diary",
        DiaryQuery,
        Diary,
        functions.get_diary,
        "Whole days with events, newest first; pass next_cursor for older days.",
        errors=(InvalidCursor,),
        view="diary",
    ),
    query(
        "get_profile",
        EmptyQuery,
        ProfileView,
        functions.get_profile,
        "The profile, today's targets, source preferences and integration status.",
        view="profile",
    ),
)
