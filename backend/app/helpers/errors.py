"""The one error model: every failure becomes an AppError with a code, status and body."""

from typing import Any, ClassVar

from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ValidationError
from sqlalchemy.exc import IntegrityError

from app.helpers.logging import get_logger

logger = get_logger("errors")

_LOCATION_PARTS = {"body", "query", "path", "header"}


class ErrorBody(BaseModel):
    """What REST returns as the response body and MCP returns as the error text."""

    code: str
    message: str
    field: str | None = None


class AppError(Exception):
    """Base of every anticipated failure; subclasses set `code` and `status`."""

    code: ClassVar[str] = "internal"
    status: ClassVar[int] = 500

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.field = field

    def body(self) -> ErrorBody:
        """The serialisable error body."""
        return ErrorBody(code=self.code, message=self.message, field=self.field)


class ValidationFailed(AppError):
    """Input is well-formed JSON but not acceptable."""

    code = "validation"
    status = 422


class NotFound(AppError):
    """A referenced entity does not exist."""

    code = "not_found"
    status = 404


class Conflict(AppError):
    """The request clashes with the current state."""

    code = "conflict"
    status = 409


class Unauthorized(AppError):
    """No valid bearer token."""

    code = "unauthorized"
    status = 401


class Forbidden(AppError):
    """A valid token, but not for this caller or client."""

    code = "forbidden"
    status = 403


class Upstream(AppError):
    """A service this backend depends on failed."""

    code = "upstream"
    status = 503


class Internal(AppError):
    """An unanticipated failure; the message never carries internals."""

    code = "internal"
    status = 500


def _field(location: Any, prefix: str) -> str | None:
    location_list = list(location)
    if len(location_list) > 1 and str(location_list[0]) in _LOCATION_PARTS:
        parts = [str(part) for part in location_list[1:]]
    else:
        parts = [str(part) for part in location_list]
    if prefix:
        parts.insert(0, prefix)
    return ".".join(parts) or None


def from_validation_errors(errors: list[dict[str, Any]], prefix: str = "") -> ValidationFailed:
    """The first pydantic/FastAPI validation error as a ValidationFailed."""
    first = errors[0] if errors else {}
    return ValidationFailed(first.get("msg", "invalid input"), _field(first.get("loc", ()), prefix))


def to_app_error(exc: BaseException) -> AppError:
    """Map any exception to an AppError; unexpected ones are logged and hidden."""
    if isinstance(exc, AppError):
        return exc
    if isinstance(exc, RequestValidationError | ValidationError):
        return from_validation_errors(list(exc.errors()))
    if isinstance(exc, IntegrityError):
        return Conflict("conflicting data")
    logger.error("unexpected error", exc_info=exc)
    return Internal("internal error")
