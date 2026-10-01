"""Models only the days feature defines: summaries, views and their inputs."""

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.features.integrations.models import SyncStatusOut
from app.features.journal.models import EventOut, Kind
from app.features.profile.models import ProfileOut, SourcePreferenceOut
from app.helpers.models import Nutrients, QueryInput


class Gauge(BaseModel):
    """One of the four gauges: value against target."""

    name: Literal["kcal", "protein", "carbs", "fat"]
    value: float
    target: float | None
    ratio: float | None


class EnergyOut(BaseModel):
    """Estimated calories out; maintenance is null when body data is missing."""

    bmr: float | None
    baseline: float | None
    steps_kcal: float
    workouts_kcal: float
    maintenance: float | None


class TargetsOut(BaseModel):
    """The day's targets; null values name their missing inputs."""

    kcal: float | None = None
    protein_g: float | None = None
    carbs_g: float | None = None
    fat_g: float | None = None
    adjustment_kcal: float | None = None
    missing: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class SleepSummary(BaseModel):
    """The sleep that ended on this day."""

    hours: float
    quality: int | None
    stages: dict[str, Any] | None


class StepsSummary(BaseModel):
    """Steps from the preferred source."""

    steps: int
    source: str


class WorkoutSummary(BaseModel):
    """Workouts on this day."""

    count: int
    minutes: float


class SymptomSummary(BaseModel):
    """One symptom type on this day."""

    type: str
    count: int
    max_severity: int


class DaySummary(BaseModel):
    """Everything computed for one local day."""

    day: dt.date
    nutrients: Nutrients
    fluid_ml: float
    sleep: SleepSummary | None
    steps: StepsSummary | None
    weight_kg: float | None
    workouts: WorkoutSummary
    symptoms: list[SymptomSummary]
    outtake_count: int
    energy: EnergyOut
    targets: TargetsOut
    gauges: list[Gauge]


class DayView(BaseModel):
    """A day's summary and its timeline."""

    summary: DaySummary
    timeline: list[EventOut]


class WeightInfo(BaseModel):
    """The latest weight and the 14-day trend."""

    latest_kg: float | None
    latest_day: dt.date | None
    trend_kg_per_week: float | None


class ContextOut(BaseModel):
    """Everything Claude needs at the start of a conversation."""

    today: dt.date
    day: DayView
    weight: WeightInfo
    recent_symptoms: list[EventOut]
    integrations: list[SyncStatusOut]
    warnings: list[str]


class DiaryDay(BaseModel):
    """One day of the diary."""

    day: dt.date
    events: list[EventOut]


class Diary(BaseModel):
    """Whole days, newest first; pass next_cursor to continue."""

    days: list[DiaryDay]
    next_cursor: str | None


class ProfileView(BaseModel):
    """The profile screen."""

    profile: ProfileOut | None
    targets_today: TargetsOut
    source_preferences: list[SourcePreferenceOut]
    integrations: list[SyncStatusOut]


class ContextQuery(QueryInput):
    """Defaults to the owner's today."""

    date: dt.date | None = None


class DayQuery(QueryInput):
    """One local day."""

    date: dt.date


class DiaryQuery(QueryInput):
    """A page of whole days."""

    cursor: str | None = None
    days: int = Field(default=7, ge=1, le=31)
    kinds: list[Kind] | None = None
