from fastapi import FastAPI

from app.helpers.endpoints import schemas_api
from app.helpers.mcp import mcp_router
from tests.clients import app_client, call_tool, call_tool_error, rpc
from tests.conftest import requires_db
from tests.helpers.toy import TOY
from tests.tokens import app_token

pytestmark = requires_db


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(mcp_router((TOY, schemas_api((TOY,)))))
    return app


async def test_every_operation_is_a_tool_with_flattened_arguments(db):
    async with app_client(_app()) as client:
        tools = {tool["name"]: tool for tool in (await rpc(client, "tools/list"))["tools"]}
    assert set(tools) == {"note_it", "write_it", "patch_it", "echo", "secret_echo", "get_schemas"}
    note = tools["note_it"]
    assert set(note["inputSchema"]["properties"]) == {"text", "fail", "idempotency_key"}
    assert note["inputSchema"]["required"] == ["text"]
    assert note["annotations"]["readOnlyHint"] is False
    assert tools["echo"]["annotations"]["readOnlyHint"] is True


async def test_tools_return_the_same_shapes_as_rest(db):
    async with app_client(_app()) as client:
        body = await call_tool(client, "note_it", {"text": "from claude"})
        assert body["result"]["text"] == "from claude"
        assert body["warnings"] == ["toy"]
        echoed = await call_tool(client, "secret_echo", {"word": "x", "times": 2})
    assert echoed == {"words": ["x", "x"], "source": "claude"}


async def test_tools_see_only_the_arguments_the_client_sent(db):
    async with app_client(_app()) as client:
        assert (await call_tool(client, "patch_it", {}))["result"]["sent"] == []
        assert (await call_tool(client, "patch_it", {"a": "x"}))["result"]["sent"] == ["a"]
        explicit = await call_tool(client, "patch_it", {"b": None})
    assert explicit["result"]["sent"] == ["b"]


async def test_arguments_failing_the_input_schema_are_rejected_by_the_sdk(db):
    async with app_client(_app()) as client:
        result = await rpc(client, "tools/call", {"name": "note_it", "arguments": {}})
    assert result["isError"] is True
    assert "text" in result["content"][0]["text"]


async def test_tool_errors_carry_the_error_body(db):
    async with app_client(_app()) as client:
        error = await call_tool_error(client, "note_it", {"text": "x", "fail": "not_found"})
        assert error == {"code": "not_found", "message": "no such note", "field": "text"}
        hidden = await call_tool_error(client, "note_it", {"text": "x", "fail": "boom"})
    assert hidden == {"code": "internal", "message": "internal error", "field": None}
    assert "secret" not in hidden.get("message", "")


async def test_mcp_rejects_missing_and_foreign_tokens(db):
    async with app_client(_app()) as client:
        missing = await client.post(
            "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        assert missing.status_code == 401
        assert "resource_metadata" in missing.headers["www-authenticate"]
        foreign = await client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={
                "Authorization": f"Bearer {app_token()}",
                "Accept": "application/json, text/event-stream",
            },
        )
        assert foreign.status_code == 401


async def test_protected_resource_metadata_advertises_openid(db):
    async with app_client(_app()) as client:
        metadata = (await client.get("/.well-known/oauth-protected-resource/mcp")).json()
    assert metadata["resource"] == "http://testserver/mcp"
    assert metadata["scopes_supported"] == ["openid"]
