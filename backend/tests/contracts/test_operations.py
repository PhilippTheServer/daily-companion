import importlib
import inspect
import pkgutil

import app.features
from app.features.journal.payloads import KINDS
from app.helpers.endpoints import BASE_ERRORS, COMMAND_ERRORS, schemas_api
from app.helpers.errors import AppError
from app.main import FEATURES, create_app
from tests.clients import rpc
from tests.conftest import requires_db

TOOLS = {
    "update_profile",
    "set_source_preference",
    "import_food",
    "save_food",
    "archive_food",
    "save_recipe",
    "archive_recipe",
    "find_food",
    "get_food",
    "get_recipe",
    "list_recipes",
    "log_events",
    "correct_event",
    "retract_event",
    "link_events",
    "unlink_events",
    "query_events",
    "get_event_history",
    "sync_now",
    "get_context",
    "get_day",
    "get_diary",
    "get_profile",
    "get_schemas",
}
OPERATIONS = [op for api in FEATURES for op in api.operations]


@requires_db
async def test_mcp_exposes_exactly_the_contract_tools(mcp):
    async with mcp() as client:
        names = {tool["name"] for tool in (await rpc(client, "tools/list"))["tools"]}
    assert names == TOOLS
    assert len(TOOLS) == 24


def test_every_feature_exception_is_declared_on_an_operation():
    declared = {error for op in OPERATIONS for error in op.errors}
    for module in pkgutil.iter_modules(app.features.__path__):
        exceptions = importlib.import_module(f"app.features.{module.name}.exceptions")
        for obj in vars(exceptions).values():
            if (
                inspect.isclass(obj)
                and issubclass(obj, AppError)
                and obj.__module__ == exceptions.__name__
            ):
                assert obj in declared, (
                    f"{obj.__name__} is raised by {module.name} but declared on no operation"
                )


def test_openapi_documents_every_declared_error():
    spec = create_app().openapi()
    for op in OPERATIONS:
        if op.rest is None:
            continue
        method, path = op.rest
        responses = spec["paths"][f"/api/v2{path}"][method.lower()]["responses"]
        extra = COMMAND_ERRORS if op.kind == "command" else ()
        for error in (*BASE_ERRORS, *extra, *op.errors):
            assert str(error.status) in responses, f"{op.name} does not document {error.code}"


def test_every_command_documents_conflict():
    spec = create_app().openapi()
    commands = [op for op in OPERATIONS if op.kind == "command"]
    assert commands
    for op in commands:
        responses = spec["paths"][f"/api/v2{op.rest[1]}"]["post"]["responses"]
        assert "409" in responses, f"{op.name} does not document 409"


def test_rest_shape_follows_the_kind():
    for op in OPERATIONS:
        if op.kind == "command":
            assert op.rest == ("POST", f"/commands/{op.name}")
        elif op.rest is not None:
            assert op.rest[0] == "GET"
    views = {op.view for op in OPERATIONS if op.view}
    assert views == {
        "today",
        "day",
        "diary",
        "event",
        "catalog",
        "food",
        "recipe",
        "recipes",
        "profile",
    }


def test_every_event_kind_publishes_its_schema():
    assert set(schemas_api(FEATURES).operations[0].output.model_fields) == {
        "commands",
        "queries",
        "payloads",
    }
    assert set(dict(next(api for api in FEATURES if api.name == "journal").schemas)) == set(KINDS)
