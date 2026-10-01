"""External clients as named, lazily built, overridable services."""

from collections.abc import Callable
from logging import getLogger
from typing import Any


class ServiceRegistry:
    """Named factories whose instances are built on first use and closed on shutdown."""

    def __init__(self) -> None:
        self._factories: dict[str, Callable[[], Any]] = {}
        self._instances: dict[str, Any] = {}

    def register(self, name: str, factory: Callable[[], Any]) -> None:
        """Declare how to build a service."""
        self._factories[name] = factory

    def is_registered(self, name: str) -> bool:
        """Whether a factory exists for the name."""
        return name in self._factories

    def get(self, name: str) -> Any:
        """The instance, built on first use; KeyError for an unknown name."""
        if name not in self._instances:
            self._instances[name] = self._factories[name]()
        return self._instances[name]

    def override(self, name: str, instance: Any) -> None:
        """Use this instance instead of building one (tests)."""
        self._instances[name] = instance

    async def aclose(self) -> None:
        """Close every built instance that has aclose(), then forget them all."""
        first_error: BaseException | None = None
        logger = getLogger("services")
        try:
            for instance in list(self._instances.values()):
                close = getattr(instance, "aclose", None)
                if close is not None:
                    try:
                        await close()
                    except BaseException as exc:
                        if first_error is None:
                            first_error = exc
                        logger.error(f"Failed to close service: {exc}", exc_info=exc)
        finally:
            self._instances.clear()
        if first_error is not None:
            raise first_error


services = ServiceRegistry()
