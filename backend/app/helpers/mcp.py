"""MCP: every operation becomes a tool with flattened arguments; extra schemas become resources."""

import inspect
import json
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import APIRouter, FastAPI
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, Field
from starlette.routing import Route

from app.helpers.auth import McpTokenVerifier, mcp_principal
from app.helpers.config import app_version, get_settings
from app.helpers.endpoints import FeatureApi, Operation, execute
from app.helpers.errors import to_app_error

INSTRUCTIONS = (
    "daily is the owner's health journal and diet system. Start every conversation with "
    "get_context. Log facts with log_events; never guess food ids, find them with find_food."
)


def _parameters(op: Operation) -> list[inspect.Parameter]:
    parameters = []
    for name, info in op.input.model_fields.items():
        metadata = list(info.metadata)
        if info.description:
            metadata.append(Field(description=info.description))
        annotation = Annotated[(info.annotation, *metadata)] if metadata else info.annotation
        default = (
            inspect.Parameter.empty
            if info.is_required()
            else info.get_default(call_default_factory=True)
        )
        parameters.append(
            inspect.Parameter(
                name, inspect.Parameter.KEYWORD_ONLY, annotation=annotation, default=default
            )
        )
    return parameters


def _tool(op: Operation) -> Any:
    async def tool(ctx: Context, **arguments: Any) -> Any:
        params = ctx.request_context.params or {}
        sent = params.get("arguments") or {}
        arguments = {name: value for name, value in arguments.items() if name in sent}
        try:
            data = op.input.model_validate(arguments)
            result = await execute(op, mcp_principal(), data)
        except Exception as exc:
            body = to_app_error(exc).body().model_dump_json()
            return CallToolResult(content=[TextContent(type="text", text=body)], is_error=True)
        return result.model_dump(mode="json")

    context = inspect.Parameter("ctx", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=Context)
    tool.__signature__ = inspect.Signature(
        [context, *_parameters(op)], return_annotation=dict[str, Any]
    )
    tool.__name__ = op.name
    tool.__doc__ = op.description
    return tool


def _add_schema_resource(server: MCPServer, name: str, model: type[BaseModel]) -> None:
    body = json.dumps(model.model_json_schema())

    def read() -> str:
        return body

    server.resource(f"daily://schema/{name}", name=f"schema-{name}", mime_type="application/json")(
        read
    )


def build_mcp_server(apis: Sequence[FeatureApi]) -> MCPServer:
    """An MCP server with one tool per operation, guarded by Keycloak."""
    settings = get_settings()
    server = MCPServer(
        "daily",
        instructions=INSTRUCTIONS,
        version=app_version(),
        token_verifier=McpTokenVerifier(settings),
        auth=AuthSettings(
            issuer_url=settings.keycloak_issuer,
            resource_server_url=settings.mcp_resource_url,
            validate_token_resource=True,
            required_scopes=["openid"],
        ),
    )
    for api in apis:
        for op in api.operations:
            server.add_tool(
                _tool(op),
                name=op.name,
                description=op.description,
                annotations=ToolAnnotations(
                    read_only_hint=op.kind == "query",
                    destructive_hint=op.destructive,
                    open_world_hint=False,
                ),
            )
        for name, model in api.schemas.items():
            _add_schema_resource(server, name, model)
    return server


def mcp_router(apis: Sequence[FeatureApi]) -> APIRouter:
    """Routes /mcp and its protected-resource metadata; carries the session manager's lifespan."""
    server = build_mcp_server(apis)
    settings = get_settings()
    asgi = server.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=settings.mcp_allowed_hosts, allowed_origins=settings.mcp_allowed_origins
        ),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        async with server.session_manager.run():
            yield

    router = APIRouter(lifespan=lifespan)
    router.routes.append(Route("/mcp", endpoint=asgi))
    router.routes.append(
        Route("/.well-known/oauth-protected-resource/mcp", endpoint=asgi, methods=["GET"])
    )
    return router
