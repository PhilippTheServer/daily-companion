"""Every error the journal feature raises."""

import uuid

from app.helpers.errors import Conflict, NotFound, ValidationFailed


def _at(prefix: str, name: str) -> str:
    return f"{prefix}.{name}" if prefix else name


class EventNotFound(NotFound):
    """The event id does not exist."""

    def __init__(self, event_id: uuid.UUID, field: str = "id") -> None:
        super().__init__(f"event {event_id} does not exist", field)


class StaleHead(Conflict):
    """The event was already corrected; correct its current version instead."""

    code = "stale_head"

    def __init__(self, event_id: uuid.UUID, head_id: uuid.UUID) -> None:
        super().__init__(
            f"event {event_id} was already corrected; the current version is {head_id}", "id"
        )


class EventRetracted(Conflict):
    """The event chain is retracted and cannot change."""

    def __init__(self, chain_id: uuid.UUID) -> None:
        super().__init__(f"event chain {chain_id} is retracted", "id")


class EndRequired(ValidationFailed):
    """The event kind needs an ends_at."""

    def __init__(self, kind: str, prefix: str = "") -> None:
        super().__init__(f"{kind} needs ends_at", _at(prefix, "ends_at"))


class EndForbidden(ValidationFailed):
    """The event kind has no ends_at."""

    def __init__(self, kind: str, prefix: str = "") -> None:
        super().__init__(f"{kind} has no ends_at", _at(prefix, "ends_at"))


class EndBeforeStart(ValidationFailed):
    """ends_at lies before occurred_at."""

    def __init__(self, prefix: str = "") -> None:
        super().__init__("ends_at is before occurred_at", _at(prefix, "ends_at"))


class SelfLink(ValidationFailed):
    """An event cannot link to itself."""

    def __init__(self, field: str = "to_chain") -> None:
        super().__init__("an event cannot link to itself", field)


class LinkNotFound(NotFound):
    """The link to remove does not exist."""

    def __init__(self) -> None:
        super().__init__("no such link", "to_chain")


class InvalidRange(ValidationFailed):
    """The requested day range is invalid."""

    def __init__(self, message: str) -> None:
        super().__init__(message, "to_day")
