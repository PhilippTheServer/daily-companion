"""Every event kind: what callers send, what is stored, and how old payloads are upgraded."""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import reduce
from operator import or_
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, create_model, model_validator

from app.helpers.models import Nutrients, StrictModel, UtcDatetime

Slot = Literal["breakfast", "lunch", "dinner", "snack"]
Relation = Literal["suspected_cause", "part_of", "follows"]
SymptomType = Literal[
    "stomach_ache",
    "gas",
    "bloated",
    "nausea",
    "diarrhea",
    "constipation",
    "heartburn",
    "headache",
    "fatigue",
    "skin",
    "other",
]
METRICS: dict[str, str] = {
    "weight_kg": "kg",
    "waist_cm": "cm",
    "body_fat_pct": "%",
    "resting_hr_bpm": "bpm",
    "hrv_ms": "ms",
    "spo2_pct": "%",
    "skin_temp_delta_c": "°C",
    "blood_pressure_sys": "mmHg",
    "blood_pressure_dia": "mmHg",
}
Metric = Literal[tuple(METRICS)]
Note = Annotated[str | None, Field(max_length=2000)]


class IntakeItemIn(StrictModel):
    """An eaten amount of a catalog food."""

    food_id: uuid.UUID
    grams: float = Field(gt=0, le=5000, description="Grams, or ml for drinks.")


class IntakeIn(StrictModel):
    """What was eaten or drunk: either items, or a recipe with portions."""

    slot: Slot | None = None
    items: list[IntakeItemIn] = Field(default_factory=list, max_length=60)
    recipe_id: uuid.UUID | None = None
    portions: float | None = Field(
        default=None, gt=0, le=20, description="Portions of the recipe; default 1."
    )
    note: Note = None

    @model_validator(mode="after")
    def _items_or_recipe(self) -> IntakeIn:
        if bool(self.items) == (self.recipe_id is not None):
            raise ValueError("send either items or recipe_id")
        if self.portions is not None and self.recipe_id is None:
            raise ValueError("portions need a recipe_id")
        return self


class IntakeItemStored(BaseModel):
    """An eaten amount with its nutrients frozen at the food version."""

    food_id: uuid.UUID
    food_version_id: uuid.UUID
    name: str
    grams: float
    nutrients: Nutrients


class IntakeStored(BaseModel):
    """An intake as stored: resolved items, their snapshot, and the total."""

    slot: Slot | None
    items: list[IntakeItemStored]
    recipe_id: uuid.UUID | None
    recipe_version_id: uuid.UUID | None
    portions: float | None
    note: str | None
    nutrients: Nutrients


class OuttakeP(StrictModel):
    """A bowel movement."""

    bristol: int = Field(ge=1, le=7, description="Bristol stool scale 1-7.")
    urgency: bool | None = None
    pain: int | None = Field(default=None, ge=0, le=5)
    flags: list[Literal["blood", "mucus", "undigested"]] = Field(default_factory=list, max_length=3)
    note: Note = None


class SymptomP(StrictModel):
    """Something felt; link it to suspected causes with links."""

    type: SymptomType
    severity: int = Field(ge=1, le=5)
    body_area: str | None = Field(default=None, max_length=100)
    note: Note = None


class DoseP(StrictModel):
    """A dose of a medication or supplement."""

    name: str = Field(min_length=1, max_length=200)
    dose: float = Field(gt=0, le=100000)
    unit: str = Field(min_length=1, max_length=20)
    reason: str | None = Field(default=None, max_length=500)
    note: Note = None


class SleepStages(StrictModel):
    """Minutes per sleep stage."""

    deep_min: int = Field(ge=0, le=1440)
    light_min: int = Field(ge=0, le=1440)
    rem_min: int = Field(ge=0, le=1440)
    awake_min: int = Field(ge=0, le=1440)


class SleepP(StrictModel):
    """A sleep period; occurred_at is falling asleep, ends_at waking up."""

    quality: int | None = Field(default=None, ge=1, le=5)
    stages: SleepStages | None = None
    efficiency_pct: float | None = Field(default=None, ge=0, le=100)
    note: Note = None


class ActivityP(StrictModel):
    """A day's movement totals; occurred_at/ends_at span the local day."""

    steps: int | None = Field(default=None, ge=0, le=200000)
    active_minutes: int | None = Field(default=None, ge=0, le=1440)
    distance_km: float | None = Field(default=None, ge=0, le=500)

    @model_validator(mode="after")
    def _something(self) -> ActivityP:
        if self.steps is None and self.active_minutes is None and self.distance_km is None:
            raise ValueError("send steps, active_minutes or distance_km")
        return self


class WorkoutSet(StrictModel):
    """One completed set."""

    reps: int | None = Field(default=None, ge=0, le=1000)
    weight_kg: float | None = Field(default=None, ge=0, le=1000)
    duration_s: int | None = Field(default=None, ge=0, le=86400)
    rpe: float | None = Field(default=None, ge=0, le=10)


class WorkoutExercise(StrictModel):
    """One exercise with its completed sets."""

    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=50)
    sets: list[WorkoutSet] = Field(default_factory=list, max_length=100)


class WorkoutP(StrictModel):
    """A training session."""

    title: str = Field(min_length=1, max_length=200)
    category: Literal["strength", "cardio", "mixed", "other"]
    set_count: int | None = Field(default=None, ge=0)
    volume_kg: float | None = Field(default=None, ge=0)
    exercises: list[WorkoutExercise] = Field(default_factory=list, max_length=50)
    note: Note = None


class MeasurementP(StrictModel):
    """One body value; the unit is fixed per metric."""

    metric: Metric
    value: float = Field(ge=-1000, le=100000)
    unit: str | None = None

    @model_validator(mode="after")
    def _unit(self) -> MeasurementP:
        expected = METRICS[self.metric]
        if self.unit not in (None, expected):
            raise ValueError(f"{self.metric} is measured in {expected}")
        self.unit = expected
        return self


class CheckinP(StrictModel):
    """How the day feels, 1 (bad) to 5 (good)."""

    overall: int = Field(ge=1, le=5)
    energy: int | None = Field(default=None, ge=1, le=5)
    mood: int | None = Field(default=None, ge=1, le=5)
    stress: int | None = Field(default=None, ge=1, le=5)
    note: Note = None


class NoteP(StrictModel):
    """Free text."""

    text: str = Field(min_length=1, max_length=5000)


Upcaster = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class KindSpec:
    """One event kind: its input and stored models, time rule and payload upgrades."""

    kind: str
    input: type[BaseModel]
    stored: type[BaseModel]
    ends: Literal["forbidden", "optional", "required"] = "optional"
    version: int = 1
    upcasters: dict[int, Upcaster] = field(default_factory=dict)


KINDS: dict[str, KindSpec] = {
    spec.kind: spec
    for spec in (
        KindSpec("intake", IntakeIn, IntakeStored, ends="forbidden"),
        KindSpec("outtake", OuttakeP, OuttakeP, ends="forbidden"),
        KindSpec("symptom", SymptomP, SymptomP),
        KindSpec("medication", DoseP, DoseP, ends="forbidden"),
        KindSpec("supplement", DoseP, DoseP, ends="forbidden"),
        KindSpec("sleep", SleepP, SleepP, ends="required"),
        KindSpec("activity", ActivityP, ActivityP, ends="required"),
        KindSpec("workout", WorkoutP, WorkoutP),
        KindSpec("measurement", MeasurementP, MeasurementP, ends="forbidden"),
        KindSpec("checkin", CheckinP, CheckinP, ends="forbidden"),
        KindSpec("note", NoteP, NoteP, ends="forbidden"),
    )
}
Kind = Literal[tuple(KINDS)]


def upcast(spec: KindSpec, version: int, payload: dict[str, Any]) -> dict[str, Any]:
    """Lift a stored payload from `version` to the kind's current version, step by step."""
    while version < spec.version:
        payload = spec.upcasters[version](payload)
        version += 1
    return payload


def current_payload(kind: str, version: int, payload: dict[str, Any]) -> dict[str, Any]:
    """A stored payload in its kind's current shape."""
    return upcast(KINDS[kind], version, payload)


class LinkIn(StrictModel):
    """Link the new event to an existing chain, e.g. a symptom to a suspected meal."""

    to_chain: uuid.UUID
    relation: Relation


def _draft(spec: KindSpec) -> type[BaseModel]:
    return create_model(
        f"{spec.kind.capitalize()}Draft",
        __base__=StrictModel,
        kind=(Literal[spec.kind], ...),
        occurred_at=(UtcDatetime, ...),
        ends_at=(UtcDatetime | None, None),
        payload=(spec.input, ...),
        links=(list[LinkIn], Field(default_factory=list, max_length=10)),
    )


DRAFTS: tuple[type[BaseModel], ...] = tuple(_draft(spec) for spec in KINDS.values())
EventDraft = Annotated[reduce(or_, DRAFTS), Field(discriminator="kind")]
