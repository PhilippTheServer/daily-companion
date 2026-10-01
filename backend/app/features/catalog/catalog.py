"""The catalog feature's API."""

from app.features.catalog.routers import OPERATIONS
from app.helpers.endpoints import FeatureApi

api = FeatureApi(name="catalog", operations=OPERATIONS)
