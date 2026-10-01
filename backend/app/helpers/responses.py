"""The shape every command answers with, and OpenAPI error docs."""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from pydantic import BaseModel, Field

from app.helpers.errors import AppError, ErrorBody


class Effects(BaseModel):
    """What a command changed that a caller may want to re-read."""

    days: list[date] = Field(default_factory=list)


class CommandResponse[T](BaseModel):
    """Every command's response: the result, its effects and any warnings."""

    result: T
    effects: Effects = Field(default_factory=Effects)
    warnings: list[str] = Field(default_factory=list)


@dataclass
class Outcome[T]:
    """What a command handler returns; the endpoint machinery turns it into a response."""

    result: T
    days: set[date] = field(default_factory=set)
    warnings: list[str] = field(default_factory=list)


def error_responses(errors: Iterable[type[AppError]]) -> dict[int | str, dict[str, Any]]:
    """OpenAPI `responses` documenting each error status and the codes behind it."""
    responses: dict[int | str, dict[str, Any]] = {}
    for error in errors:
        entry = responses.setdefault(error.status, {"model": ErrorBody, "description": ""})
        codes = [code for code in entry["description"].split(", ") if code]
        if error.code not in codes:
            codes.append(error.code)
        entry["description"] = ", ".join(codes)
    return responses
