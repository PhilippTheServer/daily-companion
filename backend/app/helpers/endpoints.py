"""Operations: declared once in a feature's routers.py, served as REST routes and MCP tools."""

import inspect
from collections.abc import Awaitable, Callable, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.helpers import idempotency
from app.helpers.auth import Principal, rest_principal
from app.helpers.config import Settings, get_settings
from app.helpers.database import open_session
from app.helpers.errors import (
    AppError,
    Conflict,
    Forbidden,
    Internal,
    NotFound,
    Unauthorized,
    Upstream,
    ValidationFailed,
    to_app_error,
)
from app.helpers.models import EmptyQuery
from app.helpers.responses import CommandResponse, Effects, Outcome, error_responses
from app.helpers.time import utcnow

BASE_ERRORS: tuple[type[AppError], ...] = (
    ValidationFailed,
    Unauthorized,
    Forbidden,
    Upstream,
    Internal,
)

COMMAND_ERRORS: tuple[type[AppError], ...] = (Conflict,)

Handler = Callable[["Context", Any], Awaitable[Any]]
Lifespan = Callable[[Any], AbstractAsyncContextManager[None]]


@dataclass(frozen=True)
class Context:
    """What a handler may use; the session is opened and committed by the machinery."""

    session: AsyncSession
    principal: Principal
    settings: Settings
    now: datetime


@dataclass(frozen=True)
class Operation:
    """One command or query, declared once and served over REST and MCP."""

    name: str
    kind: Literal["command", "query"]
    input: type[BaseModel]
    output: type[BaseModel]
    handler: Handler
    description: str
    errors: tuple[type[AppError], ...] = ()
    view: str | None = None
    rest_path: str | None = None
    destructive: bool = False

    @property
    def response_model(self) -> type[BaseModel]:
        """Commands answer with the CommandResponse envelope, queries with their output."""
        if self.kind == "command":
            return CommandResponse[self.output]
        return self.output

    @property
    def rest(self) -> tuple[str, str] | None:
        """(method, path) of the REST route, or None for MCP-only queries."""
        if self.kind == "command":
            return "POST", f"/commands/{self.name}"
        if self.rest_path:
            return "GET", self.rest_path
        if self.view:
            return "GET", f"/views/{self.view}"
        return None


def command(
    name: str,
    input: type[BaseModel],
    output: type[BaseModel],
    handler: Handler,
    description: str,
    *,
    errors: tuple[type[AppError], ...] = (),
    destructive: bool = False,
) -> Operation:
    """Declare a command (POST /commands/{name}); its handler returns an Outcome."""
    return Operation(
        name, "command", input, output, handler, description, errors, destructive=destructive
    )


def query(
    name: str,
    input: type[BaseModel],
    output: type[BaseModel],
    handler: Handler,
    description: str,
    *,
    errors: tuple[type[AppError], ...] = (),
    view: str | None = None,
    rest_path: str | None = None,
) -> Operation:
    """Declare a query; `view` or `rest_path` exposes it over REST, otherwise it is MCP-only."""
    return Operation(name, "query", input, output, handler, description, errors, view, rest_path)


async def execute(op: Operation, principal: Principal, data: BaseModel) -> BaseModel:
    """Run one operation in its own session; a command commits once, idempotently."""
    async with open_session() as session:
        ctx = Context(session=session, principal=principal, settings=get_settings(), now=utcnow())
        try:
            if op.kind == "query":
                return await op.handler(ctx, data)
            return await _run_command(op, ctx, data)
        except BaseException:
            await session.rollback()
            raise


async def _run_command(op: Operation, ctx: Context, data: BaseModel) -> BaseModel:
    key = getattr(data, "idempotency_key", None)
    if key:
        stored = await idempotency.replay(ctx.session, key, op.name)
        if stored is not None:
            return op.response_model.model_validate(stored)
    outcome: Outcome[Any] = await op.handler(ctx, data)
    response = op.response_model(
        result=outcome.result, effects=Effects(days=sorted(outcome.days)), warnings=outcome.warnings
    )
    if key:
        idempotency.remember(ctx.session, key, op.name, response.model_dump(mode="json"))
    await ctx.session.commit()
    return response


def error_response(exc: BaseException) -> JSONResponse:
    """Any exception as the JSON error body with its status."""
    error = to_app_error(exc)
    headers = {"WWW-Authenticate": "Bearer"} if isinstance(error, Unauthorized) else None
    return JSONResponse(error.body().model_dump(), status_code=error.status, headers=headers)


class AppRoute(APIRoute):
    """A route whose every failure, including validation and auth, becomes an ErrorBody."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except Exception as exc:
                return error_response(exc)

        return guarded


def _endpoint(op: Operation) -> Callable[..., Awaitable[BaseModel]]:
    async def endpoint(data: BaseModel, principal: Principal) -> BaseModel:
        return await execute(op, principal, data)

    location = Body() if op.kind == "command" else Query()
    endpoint.__signature__ = inspect.Signature(
        [
            inspect.Parameter(
                "data",
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=Annotated[op.input, location],
            ),
            inspect.Parameter(
                "principal",
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=Annotated[Principal, Depends(rest_principal)],
            ),
        ],
        return_annotation=op.response_model,
    )
    return endpoint


@dataclass(frozen=True)
class FeatureApi:
    """A feature's mini API: its operations, extra schemas, and an optional lifespan."""

    name: str
    operations: tuple[Operation, ...]
    schemas: dict[str, type[BaseModel]] = field(default_factory=dict)
    lifespan: Lifespan | None = None

    def router(self) -> APIRouter:
        """The REST routes of every operation that has one."""
        router = APIRouter(route_class=AppRoute, tags=[self.name], lifespan=self.lifespan)
        for op in self.operations:
            if op.rest is None:
                continue
            method, path = op.rest
            errors = (*BASE_ERRORS, *op.errors)
            if op.kind == "command":
                errors = (*errors, *COMMAND_ERRORS)
            router.add_api_route(
                path,
                _endpoint(op),
                methods=[method],
                name=op.name,
                description=op.description,
                response_model=op.response_model,
                responses=error_responses(errors),
            )
        return router


class SchemasOut(BaseModel):
    """JSON Schemas of every command input, query input and extra model."""

    commands: dict[str, dict[str, Any]]
    queries: dict[str, dict[str, Any]]
    payloads: dict[str, dict[str, Any]]


def schemas_api(apis: Sequence[FeatureApi]) -> FeatureApi:
    """A FeatureApi with get_schemas, describing the given APIs and itself."""

    async def get_schemas(ctx: Context, data: EmptyQuery) -> SchemasOut:
        return snapshot

    op = query(
        "get_schemas",
        EmptyQuery,
        SchemasOut,
        get_schemas,
        "JSON Schemas of every command, query and event payload kind.",
        rest_path="/schemas",
    )
    operations = [*(o for api in apis for o in api.operations), op]
    snapshot = SchemasOut(
        commands={o.name: o.input.model_json_schema() for o in operations if o.kind == "command"},
        queries={o.name: o.input.model_json_schema() for o in operations if o.kind == "query"},
        payloads={
            name: model.model_json_schema() for api in apis for name, model in api.schemas.items()
        },
    )
    return FeatureApi(name="schemas", operations=(op,))


def fallback_router() -> APIRouter:
    """Bound last: any unmatched path answers with a not_found ErrorBody."""
    router = APIRouter(route_class=AppRoute)

    @router.api_route(
        "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False
    )
    async def unmatched(path: str) -> None:
        raise NotFound(f"no route /{path}")

    return router
