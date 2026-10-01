"""Universal data models shared by every feature."""

import base64
import binascii
import json
import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.helpers.errors import ValidationFailed
from app.helpers.time import to_utc

UtcDatetime = Annotated[datetime, AfterValidator(to_utc)]


class StrictModel(BaseModel):
    """An input model that rejects unknown fields."""

    model_config = ConfigDict(extra="forbid")


class CommandInput(StrictModel):
    """Base of every command input; a repeated key replays the first response."""

    idempotency_key: str | None = Field(default=None, min_length=1, max_length=200)


class QueryInput(StrictModel):
    """Base of every query input."""


class EmptyQuery(QueryInput):
    """A query without parameters."""


class ById(QueryInput):
    """A query for one entity."""

    id: uuid.UUID


class ByIdCommand(CommandInput):
    """A command on one entity."""

    id: uuid.UUID


class Nutrients(BaseModel):
    """Absolute nutrient amounts of something eaten or drunk."""

    kcal: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    fiber_g: float = 0
    sugar_g: float = 0
    salt_g: float = 0
    fluid_ml: float = 0

    def __add__(self, other: Nutrients) -> Nutrients:
        return Nutrients(
            **{
                name: round(getattr(self, name) + getattr(other, name), 2)
                for name in Nutrients.model_fields
            }
        )

    def scaled(self, factor: float) -> Nutrients:
        """These amounts multiplied by a factor."""
        return Nutrients(
            **{name: round(getattr(self, name) * factor, 2) for name in Nutrients.model_fields}
        )

    @classmethod
    def total(cls, items: Iterable[Nutrients]) -> Nutrients:
        """The sum of many; zero for none."""
        result = cls()
        for item in items:
            result = result + item
        return result


def encode_cursor(data: dict[str, Any]) -> str:
    """An opaque, URL-safe pagination cursor."""
    return base64.urlsafe_b64encode(json.dumps(data, sort_keys=True).encode()).decode()


def decode_cursor(cursor: str) -> dict[str, Any]:
    """Read a cursor made by encode_cursor; anything else is a validation error."""
    try:
        value = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise ValidationFailed("invalid cursor", "cursor") from exc
    if not isinstance(value, dict):
        raise ValidationFailed("invalid cursor", "cursor")
    return value
