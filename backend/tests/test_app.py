from contextlib import asynccontextmanager

import httpx

from app.helpers.database import override_session_provider
from app.main import create_app
from tests.clients import rpc
from tests.conftest import requires_db

pytestmark = requires_db


async def test_health_reports_version_uptime_and_database(rest):
    response = await rest.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"]["ok"] is True
    assert body["version"] == "0.1.0"


async def test_health_is_degraded_without_a_database(db):
    @asynccontextmanager
    async def broken():
        raise ConnectionError("db down")
        yield

    override_session_provider(broken)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_app()), base_url="http://t"
    ) as client:
        response = await client.get("/health")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"


async def test_schemas_and_unknown_routes(rest):
    assert "get_schemas" in (await rest.get("/api/v2/schemas")).json()["queries"]
    missing = await rest.get("/api/v2/views/does-not-exist")
    assert (missing.status_code, missing.json()["code"]) == (404, "not_found")


async def test_mcp_is_bound(mcp):
    async with mcp() as client:
        tools = await rpc(client, "tools/list")
    assert "get_schemas" in {tool["name"] for tool in tools["tools"]}
