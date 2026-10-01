"""The integrations feature's endpoints."""

from app.features.integrations import functions
from app.features.integrations.exceptions import UnknownSource
from app.features.integrations.models import SyncNow, SyncStatusOut
from app.helpers.endpoints import command

SYNC_NOW = command(
    "sync_now",
    SyncNow,
    SyncStatusOut,
    functions.sync_now,
    "Run one external source's sync now (e.g. gym-bro) and return its status and counts.",
    errors=(UnknownSource,),
)

OPERATIONS = (SYNC_NOW,)
