"""The days feature's API."""

from app.features.days.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(name="days", operations=OPERATIONS)
