"""Pure maths for a day: energy, targets, summary, gauges, weight trend and warnings."""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime

from app.features.days.models import (
    DaySummary,
    EnergyOut,
    Gauge,
    SleepSummary,
    StepsSummary,
    SymptomSummary,
    TargetsOut,
    WorkoutSummary,
)
from app.features.journal.models import EventOut
from app.features.profile.models import ProfileOut
from app.helpers.models import Nutrients

ACTIVITY_FACTOR = 1.2
STEP_KCAL_PER_KG = 0.0004
MET_CARDIO = 7.0
MET_OTHER = 5.0
KCAL_PER_KG_BODY = 7700
MAX_ADJUSTMENT_KCAL = 750
FAT_SHARE_MIN = 0.25


@dataclass(frozen=True)
class WorkoutLoad:
    """A workout's duration and category, for the energy estimate."""

    minutes: float
    category: str


def age_on(birth: date, day: date) -> int:
    """Full years on a day."""
    return day.year - birth.year - ((day.month, day.day) < (birth.month, birth.day))


def bmr(weight_kg: float, height_cm: float, age: int, sex: str) -> float:
    """Mifflin-St Jeor basal metabolic rate."""
    return 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 if sex == "male" else -161)


def energy(
    weight_kg: float | None,
    height_cm: float | None,
    age: int | None,
    sex: str | None,
    steps: int,
    workouts: Sequence[WorkoutLoad],
) -> EnergyOut:
    """Calories out: baseline (BMR x 1.2) plus steps plus workouts."""
    steps_kcal = round(steps * weight_kg * STEP_KCAL_PER_KG, 1) if weight_kg is not None else 0.0
    workouts_kcal = (
        round(
            sum(
                ((MET_CARDIO if w.category == "cardio" else MET_OTHER) - 1)
                * weight_kg
                * w.minutes
                / 60
                for w in workouts
            ),
            1,
        )
        if weight_kg is not None
        else 0.0
    )
    if weight_kg is None or height_cm is None or age is None or sex is None:
        return EnergyOut(
            bmr=None,
            baseline=None,
            steps_kcal=steps_kcal,
            workouts_kcal=workouts_kcal,
            maintenance=None,
        )
    base = bmr(weight_kg, height_cm, age, sex)
    baseline = base * ACTIVITY_FACTOR
    return EnergyOut(
        bmr=round(base, 1),
        baseline=round(baseline, 1),
        steps_kcal=steps_kcal,
        workouts_kcal=workouts_kcal,
        maintenance=round(baseline + steps_kcal + workouts_kcal, 1),
    )


def _adjustment(profile: ProfileOut, weight_kg: float, day: date) -> tuple[float, list[str]]:
    goal, goal_date = profile.goal_weight_kg, profile.goal_date
    if goal is None or goal_date is None or day >= goal_date:
        return 0, []
    difference = goal - weight_kg
    if abs(difference) < 0.05:
        return 0, []
    raw = difference * KCAL_PER_KG_BODY / (goal_date - day).days
    if abs(raw) > MAX_ADJUSTMENT_KCAL:
        warning = (
            f"goal date not reachable at a safe pace; capped at {MAX_ADJUSTMENT_KCAL} kcal/day"
        )
        return math.copysign(MAX_ADJUSTMENT_KCAL, raw), [warning]
    return round(raw), []


def targets(
    profile: ProfileOut | None, weight_kg: float | None, day: date, energy_out: EnergyOut
) -> TargetsOut:
    """kcal, protein, carbs and fat for a day; null values name the missing inputs."""
    missing = (
        ["profile"]
        if profile is None
        else [f for f in ("height_cm", "birth_date", "sex") if getattr(profile, f) is None]
    )
    if weight_kg is None:
        missing.append("weight_kg")
    if missing or profile is None or weight_kg is None or energy_out.maintenance is None:
        return TargetsOut(missing=missing)
    adjustment, warnings = _adjustment(profile, weight_kg, day)
    kcal = round(energy_out.maintenance + adjustment)
    protein = round(profile.protein_g_per_kg * weight_kg, 1)
    fat = round(max(profile.fat_g_per_kg_min * weight_kg, FAT_SHARE_MIN * kcal / 9), 1)
    carbs = round(max(0.0, (kcal - protein * 4 - fat * 9) / 4), 1)
    return TargetsOut(
        kcal=kcal,
        protein_g=protein,
        carbs_g=carbs,
        fat_g=fat,
        adjustment_kcal=adjustment,
        warnings=warnings,
    )


def gauges(nutrients: Nutrients, target: TargetsOut) -> list[Gauge]:
    """The four gauges, in display order."""
    pairs = (
        ("kcal", nutrients.kcal, target.kcal),
        ("protein", nutrients.protein_g, target.protein_g),
        ("carbs", nutrients.carbs_g, target.carbs_g),
        ("fat", nutrients.fat_g, target.fat_g),
    )
    return [
        Gauge(
            name=name,
            value=round(value, 1),
            target=goal,
            ratio=round(value / goal, 3) if goal else None,
        )
        for name, value, goal in pairs
    ]


def pick_steps(events: Sequence[EventOut], preference: Sequence[str]) -> StepsSummary | None:
    """Steps from the most preferred source; among equals, the latest recorded."""
    candidates = [e for e in events if e.kind == "activity" and e.payload.get("steps") is not None]
    if not candidates:
        return None

    def rank(event: EventOut) -> tuple[int, float]:
        position = preference.index(event.source) if event.source in preference else len(preference)
        return position, -event.recorded_at.timestamp()

    best = min(candidates, key=rank)
    return StepsSummary(steps=best.payload["steps"], source=best.source)


def workout_loads(events: Sequence[EventOut]) -> list[WorkoutLoad]:
    """Duration and category of each workout."""
    return [
        WorkoutLoad(
            minutes=(e.ends_at - e.occurred_at).total_seconds() / 60 if e.ends_at else 0,
            category=e.payload.get("category", "other"),
        )
        for e in events
        if e.kind == "workout"
    ]


def sleep_summary(sleep: EventOut | None) -> SleepSummary | None:
    """Hours, quality and stages of a sleep event."""
    if sleep is None or sleep.ends_at is None:
        return None
    hours = round((sleep.ends_at - sleep.occurred_at).total_seconds() / 3600, 2)
    return SleepSummary(
        hours=hours, quality=sleep.payload.get("quality"), stages=sleep.payload.get("stages")
    )


def symptom_summary(events: Sequence[EventOut]) -> list[SymptomSummary]:
    """Count and worst severity per symptom type, by type."""
    grouped: dict[str, list[int]] = {}
    for event in events:
        if event.kind == "symptom":
            grouped.setdefault(event.payload["type"], []).append(event.payload["severity"])
    return [
        SymptomSummary(type=t, count=len(s), max_severity=max(s))
        for t, s in sorted(grouped.items())
    ]


def summarize(
    day: date,
    events: Sequence[EventOut],
    sleep: EventOut | None,
    weight_kg: float | None,
    profile: ProfileOut | None,
    step_preference: Sequence[str],
) -> DaySummary:
    """The whole day from its events, the night's sleep, the weight and the profile."""
    steps = pick_steps(events, step_preference)
    loads = workout_loads(events)
    age = age_on(profile.birth_date, day) if profile and profile.birth_date else None
    energy_out = energy(
        weight_kg,
        profile.height_cm if profile else None,
        age,
        profile.sex if profile else None,
        steps.steps if steps else 0,
        loads,
    )
    target = targets(profile, weight_kg, day, energy_out)
    nutrients = Nutrients.total(
        Nutrients.model_validate(e.payload["nutrients"]) for e in events if e.kind == "intake"
    )
    return DaySummary(
        day=day,
        nutrients=nutrients,
        fluid_ml=nutrients.fluid_ml,
        sleep=sleep_summary(sleep),
        steps=steps,
        weight_kg=weight_kg,
        workouts=WorkoutSummary(count=len(loads), minutes=round(sum(w.minutes for w in loads), 1)),
        symptoms=symptom_summary(events),
        outtake_count=sum(1 for e in events if e.kind == "outtake"),
        energy=energy_out,
        targets=target,
        gauges=gauges(nutrients, target),
    )


def weight_trend(points: Sequence[tuple[date, float]]) -> float | None:
    """Least-squares slope in kg per week; None with fewer than two distinct days."""
    if len({d for d, _ in points}) < 2:
        return None
    origin = min(d for d, _ in points)
    xs = [(d - origin).days for d, _ in points]
    ys = [v for _, v in points]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys, strict=True)) / sum(
        (x - mean_x) ** 2 for x in xs
    )
    return round(slope * 7, 2)


def context_warnings(
    *,
    today: date,
    day: date,
    local_now: datetime,
    summary: DaySummary,
    timeline: Sequence[EventOut],
    latest_weight_day: date | None,
    integration_errors: Sequence[tuple[str, str]],
) -> list[str]:
    """Things worth saying at the start of a conversation."""
    warnings = []
    if latest_weight_day is None or (day - latest_weight_day).days > 7:
        warnings.append("no weight logged in the last 7 days")
    if day == today and local_now.hour >= 14 and not any(e.kind == "intake" for e in timeline):
        warnings.append("no intake logged today yet")
    if summary.targets.missing:
        warnings.append("targets need: " + ", ".join(summary.targets.missing))
    warnings.extend(summary.targets.warnings)
    warnings.extend(f"{source} sync failing: {error}" for source, error in integration_errors)
    return warnings
