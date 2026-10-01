import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from app.features.journal.payloads import (
    KINDS,
    EventDraft,
    IntakeIn,
    KindSpec,
    MeasurementP,
    NoteP,
    upcast,
)

DRAFTS = TypeAdapter(EventDraft)
AT = "2026-09-30T08:00:00+02:00"
EXAMPLES = {
    "intake": {
        "items": [{"food_id": "00000000-0000-0000-0000-000000000001", "grams": 150}],
        "slot": "breakfast",
    },
    "outtake": {"bristol": 4},
    "symptom": {"type": "bloated", "severity": 2},
    "medication": {"name": "Ibuprofen", "dose": 400, "unit": "mg", "reason": "headache"},
    "supplement": {"name": "Vitamin D", "dose": 1000, "unit": "IE"},
    "sleep": {
        "quality": 4,
        "stages": {"deep_min": 80, "light_min": 240, "rem_min": 90, "awake_min": 20},
    },
    "activity": {"steps": 8421},
    "workout": {
        "title": "Push",
        "category": "strength",
        "exercises": [
            {"name": "Bench", "category": "strength", "sets": [{"reps": 8, "weight_kg": 80}]}
        ],
    },
    "measurement": {"metric": "weight_kg", "value": 84.3},
    "checkin": {"overall": 3, "mood": 4},
    "note": {"text": "slept badly"},
}


def test_every_kind_has_an_example_that_validates():
    assert set(EXAMPLES) == set(KINDS)
    for kind, payload in EXAMPLES.items():
        draft = DRAFTS.validate_python({"kind": kind, "occurred_at": AT, "payload": payload})
        assert draft.kind == kind


def test_intake_needs_items_or_a_recipe_but_not_both():
    with pytest.raises(ValidationError, match="either items or recipe_id"):
        IntakeIn()
    with pytest.raises(ValidationError, match="either items or recipe_id"):
        IntakeIn(
            items=[{"food_id": "00000000-0000-0000-0000-000000000001", "grams": 1}],
            recipe_id="00000000-0000-0000-0000-000000000002",
        )
    with pytest.raises(ValidationError, match="portions need a recipe_id"):
        IntakeIn(
            items=[{"food_id": "00000000-0000-0000-0000-000000000001", "grams": 1}], portions=2
        )
    assert IntakeIn(recipe_id="00000000-0000-0000-0000-000000000002", portions=1.5).portions == 1.5


def test_measurement_unit_is_filled_and_checked():
    assert MeasurementP(metric="weight_kg", value=84).unit == "kg"
    with pytest.raises(ValidationError):
        MeasurementP(metric="weight_kg", value=84, unit="lb")
    with pytest.raises(ValidationError):
        MeasurementP(metric="iq", value=84)


def test_activity_needs_at_least_one_value():
    with pytest.raises(ValidationError):
        DRAFTS.validate_python({"kind": "activity", "occurred_at": AT, "payload": {}})


def test_drafts_reject_naive_times_and_unknown_fields():
    with pytest.raises(ValidationError):
        DRAFTS.validate_python(
            {"kind": "note", "occurred_at": "2026-09-30T08:00:00", "payload": {"text": "x"}}
        )
    with pytest.raises(ValidationError):
        DRAFTS.validate_python(
            {"kind": "note", "occurred_at": AT, "payload": {"text": "x", "mood": 1}}
        )


def test_the_draft_schema_is_discriminated_by_kind():
    class Wrapper(BaseModel):
        event: EventDraft

    schema = Wrapper.model_json_schema()
    mapping = schema["properties"]["event"]["discriminator"]["mapping"]
    assert set(mapping) == set(KINDS)


def test_upcast_applies_each_step_in_order():
    spec = KindSpec(
        "note",
        NoteP,
        NoteP,
        ends="forbidden",
        version=3,
        upcasters={1: lambda p: {"text": p["body"]}, 2: lambda p: {"text": p["text"].strip()}},
    )
    assert upcast(spec, 1, {"body": " hi "}) == {"text": "hi"}
    assert upcast(spec, 3, {"text": "done"}) == {"text": "done"}
