"""The journal feature's API; payload schemas are published per kind."""

from app.features.journal.payloads import KINDS
from app.features.journal.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(
    name="journal",
    operations=OPERATIONS,
    schemas={kind: spec.input for kind, spec in KINDS.items()},
)
