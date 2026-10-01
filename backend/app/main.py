"""Binds the routers: health, every feature, schemas, MCP, and the fallback."""

from fastapi import FastAPI

from app import health
from app.features.catalog.catalog import api as catalog
from app.features.days.days import api as days
from app.features.integrations.integrations import api as integrations
from app.features.journal.journal import api as journal
from app.features.profile.profile import api as profile
from app.helpers.config import app_version
from app.helpers.endpoints import FeatureApi, fallback_router, schemas_api
from app.helpers.lifespan import lifespan
from app.helpers.mcp import mcp_router

FEATURES: tuple[FeatureApi, ...] = (profile, catalog, journal, integrations, days)


def create_app() -> FastAPI:
    """The application with every router bound."""
    app = FastAPI(title="daily", version=app_version(), lifespan=lifespan)
    apis = (*FEATURES, schemas_api(FEATURES))
    app.include_router(health.router)
    for api in apis:
        app.include_router(api.router(), prefix="/api/v2")
    app.include_router(mcp_router(apis))
    app.include_router(fallback_router())
    return app


app = create_app()
