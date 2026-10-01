"""The profile feature's endpoints."""

from app.features.profile import functions
from app.features.profile.exceptions import FieldRequired, GoalIncomplete
from app.features.profile.models import (
    ProfileOut,
    ProfileUpdate,
    SourcePreferenceIn,
    SourcePreferenceOut,
)
from app.helpers.endpoints import command

OPERATIONS = (
    command(
        "update_profile",
        ProfileUpdate,
        ProfileOut,
        functions.update_profile,
        "Write a new profile version: body data, timezone and goal. Only the fields sent change; "
        "null clears an optional field.",
        errors=(GoalIncomplete, FieldRequired),
    ),
    command(
        "set_source_preference",
        SourcePreferenceIn,
        SourcePreferenceOut,
        functions.set_source_preference,
        "Set which source wins for a metric when several report it, best first "
        "(e.g. steps: ring, health-connect, app).",
    ),
)
