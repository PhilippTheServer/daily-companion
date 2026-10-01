"""Drive the app over ASGI: plain REST, and MCP JSON-RPC over Streamable HTTP."""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI

from tests.tokens import mcp_token

MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def _envelope(response: httpx.Response) -> dict[str, Any]:
    if "text/event-stream" in response.headers.get("content-type", ""):
        lines = [
            line.removeprefix("data:").strip()
            for line in response.text.splitlines()
            if line.startswith("data:")
        ]
        return json.loads(lines[-1])
    return response.json()


async def rpc(
    client: httpx.AsyncClient,
    method: str,
    params: dict[str, Any] | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    """One JSON-RPC call to /mcp; returns its result, failing on a JSON-RPC error."""
    headers = dict(MCP_HEADERS)
    headers["Authorization"] = f"Bearer {token or mcp_token()}"
    response = await client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers=headers,
    )
    response.raise_for_status()
    envelope = _envelope(response)
    assert "error" not in envelope, envelope.get("error")
    return envelope["result"]


async def call_tool(
    client: httpx.AsyncClient, name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    """A successful tool call's structured content."""
    result = await rpc(client, "tools/call", {"name": name, "arguments": arguments})
    assert not result.get("isError"), result
    return result["structuredContent"]


async def call_tool_error(
    client: httpx.AsyncClient, name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    """A failed tool call's ErrorBody."""
    result = await rpc(client, "tools/call", {"name": name, "arguments": arguments})
    assert result["isError"] is True, result
    return json.loads(result["content"][0]["text"])


@asynccontextmanager
async def app_client(app: FastAPI, token: str | None = None) -> AsyncIterator[httpx.AsyncClient]:
    """A client with the app's lifespan running (needed for MCP)."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver", headers=headers
        ) as client:
            yield client
