import httpx
import pytest
import sqlalchemy as sa
from fastapi import FastAPI

from app.helpers.endpoints import fallback_router, schemas_api
from app.helpers.idempotency import CommandLog
from app.helpers.time import utcnow
from tests.conftest import requires_db
from tests.helpers.toy import CALLS, TOY
from tests.tokens import app_token, make_token, mcp_token

pytestmark = requires_db


def _app() -> FastAPI:
    app = FastAPI()
    for api in (TOY, schemas_api((TOY,))):
        app.include_router(api.router(), prefix="/api/v2")
    app.include_router(fallback_router())
    return app


@pytest.fixture
async def client(db):
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {app_token()}"},
    ) as http:
        yield http


async def test_command_returns_the_envelope(client):
    response = await client.post("/api/v2/commands/note_it", json={"text": "hi"})
    assert response.status_code == 200
    body = response.json()
    assert body["result"]["text"] == "hi"
    assert body["effects"] == {"days": [utcnow().date().isoformat()]}
    assert body["warnings"] == ["toy"]


async def test_idempotency_key_replays_without_running_again(client):
    before = CALLS["note"]
    first = await client.post(
        "/api/v2/commands/note_it", json={"text": "a", "idempotency_key": "same"}
    )
    second = await client.post(
        "/api/v2/commands/note_it", json={"text": "a", "idempotency_key": "same"}
    )
    assert first.json() == second.json()
    assert CALLS["note"] == before + 1


@pytest.mark.parametrize(
    ("body", "field"),
    [({"text": ""}, "text"), ({"text": "x", "surprise": 1}, "surprise"), ({}, "text")],
)
async def test_invalid_command_input_is_a_validation_error(client, body, field):
    response = await client.post("/api/v2/commands/note_it", json=body)
    assert response.status_code == 422
    assert response.json()["code"] == "validation"
    assert response.json()["field"] == field


async def test_feature_errors_keep_their_code_message_and_field(client):
    response = await client.post(
        "/api/v2/commands/note_it", json={"text": "x", "fail": "not_found"}
    )
    assert response.status_code == 404
    assert response.json() == {"code": "not_found", "message": "no such note", "field": "text"}


async def test_unexpected_errors_are_hidden(client):
    response = await client.post("/api/v2/commands/note_it", json={"text": "x", "fail": "boom"})
    assert response.status_code == 500
    assert response.json() == {"code": "internal", "message": "internal error", "field": None}


async def test_auth_failures(db):
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        missing = await http.post("/api/v2/commands/note_it", json={"text": "x"})
        assert missing.status_code == 401
        assert missing.headers["www-authenticate"] == "Bearer"
        wrong_client = await http.get(
            "/api/v2/views/echo",
            params={"word": "x"},
            headers={"Authorization": f"Bearer {mcp_token()}"},
        )
        assert wrong_client.status_code == 403
        assert wrong_client.json()["code"] == "forbidden"
        assert wrong_client.json()["message"] == "token was not issued for this application"
        stranger = await http.get(
            "/api/v2/views/echo",
            params={"word": "x"},
            headers={"Authorization": f"Bearer {make_token(sub='x')}"},
        )
        assert stranger.status_code == 403


async def test_query_reads_query_parameters(client):
    response = await client.get("/api/v2/views/echo", params={"word": "hi", "times": 2})
    assert response.json() == {"words": ["hi", "hi"], "source": "app"}
    bad = await client.get("/api/v2/views/echo", params={"word": "hi", "times": 9})
    assert (bad.status_code, bad.json()["field"]) == (422, "times")
    extra = await client.get("/api/v2/views/echo", params={"word": "hi", "other": 1})
    assert extra.status_code == 422


async def test_mcp_only_queries_have_no_route_and_unknown_routes_are_not_found(client):
    for path in ("/api/v2/views/secret_echo", "/api/v2/nope"):
        response = await client.get(path)
        assert (response.status_code, response.json()["code"]) == (404, "not_found")


async def test_schemas_lists_every_operation(client):
    body = (await client.get("/api/v2/schemas")).json()
    assert set(body["commands"]) == {"note_it", "write_it", "patch_it"}
    assert set(body["queries"]) == {"echo", "secret_echo", "get_schemas"}
    assert body["commands"]["note_it"]["properties"]["text"]["description"] == "What to note."


async def test_openapi_documents_declared_errors(client):
    spec = (await client.get("/openapi.json")).json()
    responses = spec["paths"]["/api/v2/commands/note_it"]["post"]["responses"]
    assert {"401", "403", "404", "422", "500", "503"} <= set(responses)


async def _log_keys(db) -> set[str]:
    db.expunge_all()
    return set((await db.execute(sa.select(CommandLog.idempotency_key))).scalars())


async def test_failed_command_rolls_back_its_writes(client, db):
    response = await client.post("/api/v2/commands/write_it", json={"key": "x", "fail": True})
    assert response.status_code == 404
    assert "toy-x" not in await _log_keys(db)


async def test_command_and_idempotency_record_commit_together(client, db):
    response = await client.post(
        "/api/v2/commands/write_it", json={"key": "y", "idempotency_key": "k-y"}
    )
    assert response.status_code == 200
    db.expunge_all()
    assert await _log_keys(db) >= {"toy-y", "k-y"}
    row = await db.get(CommandLog, "k-y")
    assert row.command == "write_it"


async def test_failed_command_does_not_consume_its_key(client, db):
    body = {"key": "z", "idempotency_key": "k-z"}
    failed = await client.post("/api/v2/commands/write_it", json={**body, "fail": True})
    assert failed.status_code == 404
    retried = await client.post("/api/v2/commands/write_it", json={**body, "fail": False})
    assert retried.status_code == 200
    assert "toy-z" in await _log_keys(db)


async def test_key_used_by_another_command_is_a_conflict(client):
    first = await client.post(
        "/api/v2/commands/note_it", json={"text": "a", "idempotency_key": "shared"}
    )
    assert first.status_code == 200
    second = await client.post(
        "/api/v2/commands/write_it", json={"key": "w", "idempotency_key": "shared"}
    )
    assert second.status_code == 409
    assert second.json()["code"] == "conflict"
    assert second.json()["field"] == "idempotency_key"


async def test_same_key_with_different_input_replays_the_first_response(client):
    first = await client.post(
        "/api/v2/commands/note_it", json={"text": "one", "idempotency_key": "dup"}
    )
    second = await client.post(
        "/api/v2/commands/note_it", json={"text": "two", "idempotency_key": "dup"}
    )
    assert second.status_code == 200
    assert second.json() == first.json()
    assert second.json()["result"]["text"] == "one"
