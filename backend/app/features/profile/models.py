"""Profile tables and the models only the profile feature defines."""

import uuid
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import sqlalchemy as sa
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base
from app.helpers.models import CommandInput

Sex = Literal["male", "female"]

PROFILE_FIELDS = (
    "timezone",
    "height_cm",
    "birth_date",
    "sex",
    "goal_weight_kg",
    "goal_date",
    "protein_g_per_kg",
    "fat_g_per_kg_min",
    "gym_sessions_per_week",
)
REQUIRED_FIELDS = ("timezone", "protein_g_per_kg", "fat_g_per_kg_min")


class ProfileVersion(Base):
    """One version of the owner's profile, valid from `valid_from` until the next one."""

    __tablename__ = "profile_version"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    valid_from: Mapped[datetime] = mapped_column(index=True)
    timezone: Mapped[str] = mapped_column(sa.String(64))
    height_cm: Mapped[float | None]
    birth_date: Mapped[date | None]
    sex: Mapped[str | None] = mapped_column(sa.String(10))
    goal_weight_kg: Mapped[float | None]
    goal_date: Mapped[date | None]
    protein_g_per_kg: Mapped[float]
    fat_g_per_kg_min: Mapped[float]
    gym_sessions_per_week: Mapped[float | None]


class SourcePreference(Base):
    """Which source wins when several report the same metric, best first."""

    __tablename__ = "source_preference"

    metric: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    sources: Mapped[list[Any]]


class ProfileUpdate(CommandInput):
    """Only the fields sent change; null clears an optional field."""

    timezone: str | None = Field(
        default=None, min_length=1, max_length=64, description="IANA name, e.g. Europe/Berlin."
    )
    height_cm: float | None = Field(default=None, gt=50, lt=260)
    birth_date: date | None = None
    sex: Sex | None = None
    goal_weight_kg: float | None = Field(default=None, gt=20, lt=400)
    goal_date: date | None = None
    protein_g_per_kg: float | None = Field(default=None, gt=0, le=4)
    fat_g_per_kg_min: float | None = Field(default=None, gt=0, le=3)
    gym_sessions_per_week: float | None = Field(default=None, ge=0, le=14)

    @field_validator("timezone")
    @classmethod
    def _known_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("unknown IANA timezone") from exc
        return value


class ProfileOut(BaseModel):
    """A profile version."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    valid_from: datetime
    timezone: str
    height_cm: float | None
    birth_date: date | None
    sex: Sex | None
    goal_weight_kg: float | None
    goal_date: date | None
    protein_g_per_kg: float
    fat_g_per_kg_min: float
    gym_sessions_per_week: float | None


class SourcePreferenceIn(CommandInput):
    """Set the source order for one metric, e.g. steps: [ring, health-connect, app]."""

    metric: str = Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=64)
    sources: list[str] = Field(min_length=1, max_length=10)


class SourcePreferenceOut(BaseModel):
    """A metric's source order."""

    metric: str
    sources: list[str]
