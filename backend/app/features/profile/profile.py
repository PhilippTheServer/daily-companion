"""The profile feature's API."""

from app.features.profile.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(name="profile", operations=OPERATIONS)
