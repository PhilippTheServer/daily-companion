"""The journal feature's endpoints."""

from app.features.catalog.exceptions import (
    FoodArchived,
    FoodNotFound,
    RecipeArchived,
    RecipeNotFound,
)
from app.features.journal import functions
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
    EventHistory,
    EventOut,
    EventsOut,
    LinkEvents,
    LinkResult,
    LogEvents,
    QueryEvents,
    RetractEvent,
)
from app.helpers.endpoints import command, query

_TIME_ERRORS = (EndRequired, EndForbidden, EndBeforeStart)
_FOOD_ERRORS = (FoodNotFound, FoodArchived, RecipeNotFound, RecipeArchived)

OPERATIONS = (
    command(
        "log_events",
        LogEvents,
        EventsOut,
        functions.log_events,
        "Log 1-50 facts about the owner's body and day. Each event has kind, occurred_at (ISO with "
        "offset), optional ends_at (required for sleep and activity), payload (shape per kind; see "
        "get_schemas or the daily://schema/{kind} resources) and optional links to earlier chains, "
        "e.g. a symptom with relation suspected_cause to an intake. An intake lists items "
        "(food_id from find_food, grams) or a recipe_id with portions.",
        errors=(EventNotFound, SelfLink, *_TIME_ERRORS, *_FOOD_ERRORS),
    ),
    command(
        "correct_event",
        CorrectEvent,
        EventOut,
        functions.correct_event,
        "Correct a fact: send the current version's id and the new occurred_at/ends_at and/or the "
        "whole new payload. The old version stays in history; links survive.",
        errors=(EventNotFound, StaleHead, EventRetracted, *_TIME_ERRORS, *_FOOD_ERRORS),
    ),
    command(
        "retract_event",
        RetractEvent,
        EventOut,
        functions.retract_event,
        "Retract a fact logged by mistake (current version's id). It stops counting everywhere but "
        "stays in history.",
        errors=(EventNotFound, StaleHead),
        destructive=True,
    ),
    command(
        "link_events",
        LinkEvents,
        LinkResult,
        functions.link_events,
        "Relate two chains, e.g. a symptom (from) suspected_cause an intake (to).",
        errors=(EventNotFound, SelfLink),
    ),
    command(
        "unlink_events",
        LinkEvents,
        LinkResult,
        functions.unlink_events,
        "Remove a link between two chains.",
        errors=(LinkNotFound,),
        destructive=True,
    ),
    query(
        "query_events",
        QueryEvents,
        EventsOut,
        functions.query_events,
        "Read facts between two local days (at most 366), optionally filtered by kind, with links. "
        "Use it for analyses across days.",
        errors=(InvalidRange,),
    ),
    query(
        "get_event_history",
        ChainQuery,
        EventHistory,
        functions.get_event_history,
        "Every version of one fact (chain), oldest first, with its links.",
        errors=(EventNotFound,),
        view="event",
    ),
)
