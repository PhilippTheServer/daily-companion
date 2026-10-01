import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from app.features.days.calculations import (
    ACTIVITY_FACTOR,
    WorkoutLoad,
    age_on,
    context_warnings,
    energy,
    gauges,
    pick_steps,
    summarize,
    targets,
    weight_trend,
)
from app.features.journal.models import EventOut
from app.features.profile.models import ProfileOut
from app.helpers.models import Nutrients

DAY = date(2026, 9, 30)


def profile(**overrides) -> ProfileOut:
    values = {
        "id": uuid.uuid4(),
        "valid_from": datetime(2026, 9, 1, tzinfo=UTC),
        "timezone": "Europe/Berlin",
        "height_cm": 180,
        "birth_date": date(2001, 7, 29),
        "sex": "male",
        "goal_weight_kg": None,
        "goal_date": None,
        "protein_g_per_kg": 1.8,
        "fat_g_per_kg_min": 0.8,
        "gym_sessions_per_week": 3.5,
    }
    return ProfileOut(**(values | overrides))


def ev(
    kind: str,
    payload: dict,
    at: str = "2026-09-30T08:00:00+00:00",
    ends: str | None = None,
    source: str = "app",
    recorded: int = 0,
) -> EventOut:
    moment = datetime.fromisoformat(at)
    return EventOut(
        id=uuid.uuid4(),
        chain_id=uuid.uuid4(),
        version=1,
        kind=kind,
        occurred_at=moment,
        ends_at=datetime.fromisoformat(ends) if ends else None,
        local_day=DAY,
        payload=payload,
        source=source,
        recorded_at=datetime(2026, 9, 30, tzinfo=UTC) + timedelta(minutes=recorded),
        retracted=False,
        retract_reason=None,
    )


def test_age_counts_birthdays():
    assert age_on(date(2001, 7, 29), DAY) == 25
    assert age_on(date(2001, 12, 1), DAY) == 24


def test_energy_adds_steps_and_workouts_to_the_baseline():
    result = energy(84.3, 180, 25, "male", 8000, [WorkoutLoad(minutes=31, category="strength")])
    assert (result.bmr, result.baseline) == (1848.0, 2217.6)
    assert (result.steps_kcal, result.workouts_kcal) == (269.8, 174.2)
    assert result.maintenance == pytest.approx(2661.6)
    cardio = energy(84.3, 180, 25, "male", 0, [WorkoutLoad(minutes=60, category="cardio")])
    assert cardio.workouts_kcal == pytest.approx(505.8)


def test_energy_without_body_data_has_no_maintenance():
    assert energy(84.3, None, 25, "male", 1000, []).maintenance is None
    assert energy(None, 180, 25, "male", 1000, []).steps_kcal == 0


def test_targets_move_toward_the_goal():
    base = energy(84.3, 180, 25, "male", 0, [])
    result = targets(profile(goal_weight_kg=77, goal_date=date(2027, 1, 1)), 84.3, DAY, base)
    assert (result.adjustment_kcal, result.kcal, result.protein_g, result.fat_g) == (
        -604,
        1614,
        151.7,
        67.4,
    )
    assert result.carbs_g == pytest.approx(100.15, abs=0.06)
    assert result.warnings == []


def test_targets_clamp_an_impossible_pace_and_say_so():
    base = energy(84.3, 180, 25, "male", 0, [])
    result = targets(profile(goal_weight_kg=77, goal_date=date(2026, 10, 30)), 84.3, DAY, base)
    assert result.adjustment_kcal == -750
    assert result.warnings == ["goal date not reachable at a safe pace; capped at 750 kcal/day"]


def test_no_adjustment_without_a_future_goal():
    base = energy(84.3, 180, 25, "male", 0, [])
    assert targets(profile(), 84.3, DAY, base).adjustment_kcal == 0
    assert targets(profile(goal_weight_kg=77, goal_date=DAY), 84.3, DAY, base).adjustment_kcal == 0


def test_fat_floor_uses_the_larger_of_body_weight_and_calorie_share():
    base = energy(84.3, 180, 25, "male", 20000, [WorkoutLoad(minutes=120, category="cardio")])
    result = targets(profile(fat_g_per_kg_min=0.5), 84.3, DAY, base)
    assert result.fat_g == round(0.25 * result.kcal / 9, 1)


def test_targets_name_what_is_missing():
    base = energy(None, None, None, None, 0, [])
    assert targets(None, None, DAY, base).missing == ["profile", "weight_kg"]
    no_birth = targets(profile(birth_date=None), 84.3, DAY, energy(84.3, 180, None, "male", 0, []))
    assert (no_birth.missing, no_birth.kcal) == (["birth_date"], None)


def test_gauges_compare_intake_with_targets():
    base = energy(84.3, 180, 25, "male", 0, [])
    target = targets(profile(), 84.3, DAY, base)
    result = {g.name: g for g in gauges(Nutrients(kcal=target.kcal / 2, protein_g=10), target)}
    assert result["kcal"].ratio == 0.5
    assert set(result) == {"kcal", "protein", "carbs", "fat"}
    empty = gauges(Nutrients(), targets(None, None, DAY, base))
    assert all(g.ratio is None for g in empty)


def test_steps_follow_the_source_preference_then_recency():
    phone = ev("activity", {"steps": 6000}, source="app", recorded=5)
    ring = ev("activity", {"steps": 8421}, source="ring", recorded=1)
    assert pick_steps([phone, ring], ["ring", "app"]).source == "ring"
    assert pick_steps([phone, ring], []).steps == 6000
    assert pick_steps([ev("note", {"text": "x"})], []) is None


def test_summarize_builds_the_whole_day():
    events = [
        ev("intake", {"nutrients": {"kcal": 400, "protein_g": 30, "fluid_ml": 0}}),
        ev("intake", {"nutrients": {"kcal": 0, "fluid_ml": 500}}),
        ev("symptom", {"type": "bloated", "severity": 2}),
        ev("symptom", {"type": "bloated", "severity": 4}),
        ev("outtake", {"bristol": 4}),
        ev(
            "workout",
            {"category": "strength", "title": "Push"},
            at="2026-09-30T17:00:00+00:00",
            ends="2026-09-30T17:30:00+00:00",
        ),
    ]
    sleep = ev(
        "sleep", {"quality": 4}, at="2026-09-29T22:00:00+00:00", ends="2026-09-30T06:00:00+00:00"
    )
    summary = summarize(DAY, events, sleep, 84.3, profile(), [])
    assert (summary.nutrients.kcal, summary.fluid_ml) == (400, 500)
    assert [(s.type, s.count, s.max_severity) for s in summary.symptoms] == [("bloated", 2, 4)]
    assert (summary.outtake_count, summary.workouts.count, summary.workouts.minutes) == (1, 1, 30)
    assert (summary.sleep.hours, summary.sleep.quality) == (8.0, 4)
    assert summary.energy.workouts_kcal > 0
    assert [g.name for g in summary.gauges] == ["kcal", "protein", "carbs", "fat"]


def test_weight_trend_is_the_slope_per_week():
    assert weight_trend([(date(2026, 9, 28), 85.5), (date(2026, 9, 29), 84.3)]) == -8.4
    assert weight_trend([(DAY, 84.0)]) is None
    assert weight_trend([]) is None


def test_context_warnings():
    summary = summarize(DAY, [], None, None, None, [])
    at_three = datetime(2026, 9, 30, 15, 0, tzinfo=UTC)
    warnings = context_warnings(
        today=DAY,
        day=DAY,
        local_now=at_three,
        summary=summary,
        timeline=[],
        latest_weight_day=None,
        integration_errors=[("gym-bro", "gym-bro did not answer")],
    )
    assert warnings == [
        "no weight logged in the last 7 days",
        "no intake logged today yet",
        "targets need: profile, weight_kg",
        "gym-bro sync failing: gym-bro did not answer",
    ]
    morning = context_warnings(
        today=DAY,
        day=DAY,
        local_now=at_three.replace(hour=9),
        summary=summary,
        timeline=[],
        latest_weight_day=DAY,
        integration_errors=[],
    )
    assert morning == ["targets need: profile, weight_kg"]


def test_female_bmr():
    """Female BMR via Mifflin-St Jeor: 10*60 + 6.25*165 - 5*30 - 161 = 1320.25."""
    result = energy(60, 165, 30, "female", 0, [])
    assert result.bmr == round(10 * 60 + 6.25 * 165 - 5 * 30 - 161, 1)
    assert result.baseline == pytest.approx(result.bmr * ACTIVITY_FACTOR, abs=0.1)


def test_goal_already_reached():
    """Adjustment is 0 when current weight is at or within 0.05 kg of goal."""
    base = energy(84.3, 180, 25, "male", 0, [])
    result = targets(profile(goal_weight_kg=84.3, goal_date=date(2027, 1, 1)), 84.3, DAY, base)
    assert result.adjustment_kcal == 0
    assert result.warnings == []


def test_positive_clamp():
    """Large gain goal capped at +750 kcal/day with warning."""
    base = energy(84.3, 180, 25, "male", 0, [])
    result = targets(
        profile(goal_weight_kg=90, goal_date=date(2026, 10, 10)),  # 10 days away
        84.3,
        DAY,
        base,
    )
    assert result.adjustment_kcal == 750
    assert "capped at 750 kcal/day" in result.warnings[0]
    assert result.kcal == round(base.maintenance + 750)


def test_deficit_clamp():
    """Large loss goal capped at -750 kcal/day with warning."""
    base = energy(84.3, 180, 25, "male", 0, [])
    result = targets(
        profile(goal_weight_kg=77, goal_date=date(2026, 10, 10)),  # 10 days away
        84.3,
        DAY,
        base,
    )
    assert result.adjustment_kcal == -750
    assert "capped at 750 kcal/day" in result.warnings[0]
    assert result.kcal == round(base.maintenance - 750)


def test_workout_without_end_time():
    """Workout without ends_at counts as 0 minutes; workouts_kcal is 0."""
    events = [
        ev(
            "workout",
            {"category": "strength", "title": "Incomplete"},
            at="2026-09-30T17:00:00+00:00",
            ends=None,
        ),
    ]
    summary = summarize(DAY, events, None, 84.3, profile(), [])
    assert summary.workouts.count == 1
    assert summary.workouts.minutes == 0
    assert summary.energy.workouts_kcal == 0.0


def test_weight_zero():
    """Weight 0.0 yields steps_kcal 0 without error (uses 'is not None' check)."""
    result = energy(0.0, 180, 25, "male", 10000, [])
    assert result.steps_kcal == 0.0
    assert result.workouts_kcal == 0.0
    assert result.bmr == pytest.approx(round(10 * 0 + 6.25 * 180 - 5 * 25 + 5, 1))


def test_context_warnings_with_capped_pace():
    """Capped-pace warning from summary.targets.warnings appears in context_warnings."""
    summary = summarize(
        DAY,
        [],
        None,
        84.3,
        profile(goal_weight_kg=90, goal_date=date(2026, 10, 10)),  # 10 days, capped pace
        [],
    )
    assert any("capped at 750" in w for w in summary.targets.warnings)
    warnings = context_warnings(
        today=DAY,
        day=DAY,
        local_now=datetime(2026, 9, 30, 9, 0, tzinfo=UTC),
        summary=summary,
        timeline=[],
        latest_weight_day=DAY,
        integration_errors=[],
    )
    assert any("capped at 750" in w for w in warnings)
