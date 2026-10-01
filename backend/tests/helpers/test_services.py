import pytest
from fastapi import FastAPI

from app.helpers.lifespan import lifespan
from app.helpers.services import ServiceRegistry, services


class _Client:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class _FailingClient:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        raise RuntimeError("close failed")


@pytest.fixture
def _snapshot_services():
    """Snapshot and restore services to fix test isolation."""
    factories_backup = services._factories.copy()
    instances_backup = services._instances.copy()
    yield
    services._factories = factories_backup
    services._instances = instances_backup


async def test_services_are_built_lazily_once():
    registry = ServiceRegistry()
    built = []
    registry.register("off", lambda: built.append(1) or _Client())
    assert built == []
    first = registry.get("off")
    assert registry.get("off") is first
    assert built == [1]


async def test_override_replaces_the_instance_and_aclose_closes_everything():
    registry = ServiceRegistry()
    registry.register("off", _Client)
    fake = _Client()
    registry.override("off", fake)
    assert registry.get("off") is fake
    await registry.aclose()
    assert fake.closed
    assert registry.get("off") is not fake


def test_unknown_service_is_a_key_error():
    with pytest.raises(KeyError):
        ServiceRegistry().get("nope")
    assert ServiceRegistry().is_registered("nope") is False


async def test_aclose_closes_all_services_despite_errors():
    """When one service fails to close, others must still be closed."""
    registry = ServiceRegistry()
    failing = _FailingClient()
    good = _Client()
    registry.register("good", _Client)
    registry.override("failing", failing)
    registry.override("good", good)

    with pytest.raises(RuntimeError, match="close failed"):
        await registry.aclose()

    assert good.closed
    assert registry.get("good") is not good


async def test_aclose_always_clears_instances():
    """Instances are cleared even if close raises."""
    registry = ServiceRegistry()
    failing = _FailingClient()
    registry.override("failing", failing)

    with pytest.raises(RuntimeError):
        await registry.aclose()

    assert registry._instances == {}


async def test_lifespan_closes_services_on_shutdown(
    _snapshot_services,
):
    fake = _Client()
    services.register("test-only", _Client)
    services.override("test-only", fake)
    app = FastAPI(lifespan=lifespan)
    async with app.router.lifespan_context(app):
        assert not fake.closed
    assert fake.closed


async def test_lifespan_disposes_engine_even_when_services_aclose_raises(
    _snapshot_services,
    monkeypatch,
):
    """dispose_engine must run even when services.aclose() raises."""
    dispose_called = []
    configure_called = []

    async def fake_dispose():
        dispose_called.append(True)

    def fake_configure(*args, **kwargs):
        configure_called.append(True)

    failing_service = _FailingClient()
    services.register("failing", _FailingClient)
    services.override("failing", failing_service)

    monkeypatch.setattr("app.helpers.lifespan.dispose_engine", fake_dispose)
    monkeypatch.setattr("app.helpers.lifespan.configure_logging", fake_configure)

    app = FastAPI(lifespan=lifespan)

    with pytest.raises(RuntimeError, match="close failed"):
        async with app.router.lifespan_context(app):
            pass

    assert configure_called == [True]
    assert dispose_called == [True]
