"""One-off migration of the owner's daily v1 data into daily2 Core.

Every record is written through the v2 operation handlers with the owner principal and a
deterministic idempotency key (`v1:<table>:<id>`), so a second run replays and creates nothing.
The whole run is one transaction; each record has its own savepoint, so a record v2 rejects is
skipped and reported while the rest continues.

Export v1 (one JSON array per table) and run it inside the daily2-backend container:

    mkdir -p /tmp/v1export
    for t in food recipe recipe_item meal meal_item drink medication sleep steps feeling \
             bowel_movement body_check day_checkin profile workout; do
      docker exec daily-db psql -U daily -d daily -At \
        -c "select coalesce(json_agg(t), '[]') from $t t" > /tmp/v1export/$t.json
    done
    docker cp /tmp/v1export daily2-backend:/tmp/v1export
    docker cp backend/scripts/migrate_v1.py daily2-backend:/tmp/migrate_v1.py
    docker exec -w /app -e PYTHONPATH=/app daily2-backend \
      python /tmp/migrate_v1.py /tmp/v1export --dry-run
    docker exec -w /app -e PYTHONPATH=/app daily2-backend python /tmp/migrate_v1.py /tmp/v1export

Not migrated: v1 workouts (gym-bro syncs them into v2 itself), and stock_item, planned_meal and
batch (Core has no kitchen feature).
"""

import argparse
import asyncio
import json
import sys
import uuid
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from app.features.catalog.catalog import api as catalog_api
from app.features.days.days import api as days_api
from app.features.journal.journal import api as journal_api
from app.features.profile.profile import api as profile_api
from app.helpers import idempotency
from app.helpers.auth import Principal
from app.helpers.config import get_settings
from app.helpers.database import dispose_engine, open_session
from app.helpers.endpoints import Context, Operation
from app.helpers.errors import AppError, Upstream
from app.helpers.responses import Effects
from app.helpers.services import services
from app.helpers.time import day_bounds, utcnow

OPS: dict[str, Operation] = {
    op.name: op
    for api in (catalog_api, journal_api, profile_api, days_api)
    for op in api.operations
}
TABLES = [
    "food",
    "recipe",
    "recipe_item",
    "meal",
    "meal_item",
    "drink",
    "medication",
    "sleep",
    "steps",
    "feeling",
    "bowel_movement",
    "body_check",
    "day_checkin",
    "profile",
    "workout",
]
BODY_METRICS = {
    "weight_kg": "weight_kg",
    "waist_cm": "waist_cm",
    "body_fat_pct": "body_fat_pct",
    "resting_hr_bpm": "resting_hr_bpm",
    "bp_systolic": "blood_pressure_sys",
    "bp_diastolic": "blood_pressure_dia",
}
PER_100 = {
    "kcal": "kcal_100",
    "protein_g": "protein_100",
    "carbs_g": "carbs_100",
    "fat_g": "fat_100",
    "fiber_g": "fiber_100",
    "sugar_g": "sugar_100",
    "salt_g": "salt_100",
}
OFF_PAUSE_SECONDS = 0.7


class Skipped(Exception):
    """A record the migration leaves out on purpose."""


class Migration:
    """Runs commands like helpers.endpoints._run_command, but inside one outer transaction."""

    def __init__(self, session, principal: Principal) -> None:
        self.session = session
        self.principal = principal
        self.created: Counter[str] = Counter()
        self.replayed: Counter[str] = Counter()
        self.skipped: list[tuple[str, str]] = []
        self.notes: list[str] = []
        self.foods: dict[str, uuid.UUID] = {}
        self.recipes: dict[str, uuid.UUID] = {}
        self.meals: dict[str, uuid.UUID] = {}

    def _ctx(self) -> Context:
        return Context(self.session, self.principal, get_settings(), utcnow())

    async def command(self, name: str, data: dict[str, Any], key: str, tally: str) -> Any:
        op = OPS[name]
        async with self.session.begin_nested():
            stored = await idempotency.replay(self.session, key, op.name)
            if stored is not None:
                self.replayed[tally] += 1
                return op.response_model.model_validate(stored).result
            payload = op.input.model_validate({**data, "idempotency_key": key})
            outcome = await op.handler(self._ctx(), payload)
            response = op.response_model(
                result=outcome.result,
                effects=Effects(days=sorted(outcome.days)),
                warnings=outcome.warnings,
            )
            idempotency.remember(self.session, key, op.name, response.model_dump(mode="json"))
            await self.session.flush()
        self.created[tally] += 1
        return response.result

    async def replayed_result(self, name: str, key: str) -> Any:
        stored = await idempotency.replay(self.session, key, name)
        return None if stored is None else OPS[name].response_model.model_validate(stored).result

    async def query(self, name: str, data: dict[str, Any]) -> BaseModel:
        op = OPS[name]
        return await op.handler(self._ctx(), op.input.model_validate(data))

    async def attempt(self, label: str, coro) -> Any:
        """Run one record in its own savepoint; a rejected record is rolled back and listed."""
        try:
            async with self.session.begin_nested():
                return await coro
        except Skipped as exc:
            self.skipped.append((label, str(exc)))
        except AppError as exc:
            self.skipped.append((label, f"{exc.code}: {exc.message} (field {exc.field})"))
        except ValidationError as exc:
            reasons = "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors())
            self.skipped.append((label, f"validation: {reasons}"))
        return None

    async def log(self, key: str, tally: str, draft: dict[str, Any]) -> Any:
        result = await self.command("log_events", {"events": [draft]}, key, tally)
        return result.events[0]


def load(export: Path) -> dict[str, list[dict[str, Any]]]:
    return {t: json.loads((export / f"{t}.json").read_text() or "[]") for t in TABLES}


def ts(value: str) -> datetime:
    return datetime.fromisoformat(value)


def per_100(food: dict[str, Any]) -> dict[str, float | None]:
    return {name: food[column] for name, column in PER_100.items()}


async def migrate_profile(m: Migration, rows: list[dict[str, Any]]) -> None:
    for row in rows:
        data = {
            "timezone": row["timezone"],
            "height_cm": row["height_cm"],
            "birth_date": row["birth_date"],
            "sex": row["sex"],
            "goal_weight_kg": row["target_weight_kg"],
            "goal_date": row["target_weight_date"],
            "gym_sessions_per_week": row["gym_sessions_per_week"],
        }
        await m.attempt(
            f"profile:{row['id']}",
            m.command("update_profile", data, f"v1:profile:{row['id']}", "profile"),
        )
        if row.get("gym_session_minutes") is not None:
            m.notes.append(
                f"profile.gym_session_minutes={row['gym_session_minutes']} has no v2 field"
            )


async def _import_off(m: Migration, barcode: str, key: str) -> Any:
    if await m.replayed_result("import_food", key) is None:
        await asyncio.sleep(OFF_PAUSE_SECONDS)
    for attempt in range(3):
        try:
            return await m.command("import_food", {"barcode": barcode}, key, "food_off_import")
        except Upstream:
            if attempt == 2:
                raise
            await asyncio.sleep(2 * (attempt + 1))
    return None


async def migrate_food(m: Migration, food: dict[str, Any], kind: str) -> None:
    fid = food["id"]
    fields = {"name": food["name"], "brand": food["brand"], "kind": kind}
    if food["unit_name"] is not None:
        fields |= {"unit_name": food["unit_name"], "unit_grams": food["unit_grams"]}
    if food["pack_grams"] is not None:
        fields["pack_grams"] = food["pack_grams"]
    if food["price"] is not None:
        m.notes.append(f"food {food['name']}: price {food['price']} has no v2 field")
    manual = await m.replayed_result("save_food", f"v1:food:{fid}:create")
    if manual is not None:
        m.replayed["food"] += 1
        m.foods[fid] = manual.id
        return
    imported = None
    try:
        imported = await _import_off(m, food["off_code"], f"v1:food:{fid}:import")
    except AppError as exc:
        m.notes.append(
            f"food {food['name']} ({food['off_code']}): OFF import failed ({exc.code}: "
            f"{exc.message}); created by hand without barcode"
        )
    if imported is not None and imported.id in m.foods.values():
        m.notes.append(
            f"food {food['name']} ({food['off_code']}): OFF returned a food already used by "
            "another v1 food; created by hand without barcode"
        )
        imported = None
    if imported is None:
        data = fields | {"per_100": per_100(food)}
        result = await m.command("save_food", data, f"v1:food:{fid}:create", "food")
    else:
        if imported.barcode != food["off_code"]:
            m.notes.append(
                f"food {food['name']}: OFF canonical barcode {imported.barcode} "
                f"(v1 {food['off_code']})"
            )
        data = fields | {"id": str(imported.id), "per_100": per_100(food)}
        result = await m.command("save_food", data, f"v1:food:{fid}:update", "food")
    m.foods[fid] = result.id


async def migrate_catalog(m: Migration, v1: dict[str, list[dict[str, Any]]]) -> None:
    eaten = {i["food_id"] for i in v1["meal_item"]} | {i["food_id"] for i in v1["recipe_item"]}
    drunk = {d["food_id"] for d in v1["drink"] if d["food_id"]}
    for food in sorted(v1["food"], key=lambda f: f["fetched_at"]):
        kind = "drink" if food["id"] in drunk and food["id"] not in eaten else "food"
        await m.attempt(f"food:{food['id']} {food['name']}", migrate_food(m, food, kind))

    for name in sorted({d["name"] for d in v1["drink"] if not d["food_id"]}):
        data = {
            "name": name,
            "kind": "drink",
            "per_100": dict.fromkeys(PER_100, 0.0),
        }
        result = await m.attempt(
            f"drink-food:{name}",
            m.command("save_food", data, f"v1:drink-food:{name}", "drink_food"),
        )
        if result is not None:
            m.foods[f"drink:{name}"] = result.id

    items: dict[str, list[dict[str, Any]]] = {}
    for item in sorted(v1["recipe_item"], key=lambda i: i["position"]):
        items.setdefault(item["recipe_id"], []).append(item)
    for recipe in sorted(v1["recipe"], key=lambda r: r["created_at"]):
        rid = recipe["id"]

        async def save(recipe: dict[str, Any] = recipe, rid: str = rid) -> None:
            missing = [i["food_id"] for i in items.get(rid, []) if i["food_id"] not in m.foods]
            if missing:
                raise Skipped(f"ingredient foods not migrated: {missing}")
            data = {
                "name": recipe["name"],
                "serves": recipe["serves"] or 1,
                "steps": recipe["instructions"] or [],
                "items": [
                    {"food_id": str(m.foods[i["food_id"]]), "grams": i["grams"]}
                    for i in items.get(rid, [])
                ],
                "note": recipe["note"],
            }
            result = await m.command("save_recipe", data, f"v1:recipe:{rid}", "recipe")
            m.recipes[rid] = result.id

        await m.attempt(f"recipe:{rid} {recipe['name']}", save())


def _recipe_portions(
    meal_items: list[dict[str, Any]], recipe_items: list[dict[str, Any]], serves: int
) -> float | None:
    """Portions when the meal's items are exactly the recipe's items scaled; else None."""
    if len(meal_items) != len(recipe_items) or not recipe_items:
        return None
    factor = meal_items[0]["grams"] / recipe_items[0]["grams"]
    for eaten, planned in zip(meal_items, recipe_items, strict=True):
        if eaten["food_id"] != planned["food_id"]:
            return None
        if abs(eaten["grams"] - round(planned["grams"] * factor, 2)) > 0.05:
            return None
    portions = round(factor * serves, 4)
    return portions if 0 < portions <= 20 else None


async def migrate_journal(m: Migration, v1: dict[str, list[dict[str, Any]]]) -> list[str]:
    day_mismatch: list[str] = []
    tz = get_settings().default_timezone
    by_id = {f["id"]: f for f in v1["food"]}

    def check_day(label: str, event: Any, v1_day: str) -> None:
        if event is not None and event.local_day != date.fromisoformat(v1_day):
            day_mismatch.append(f"{label}: v1 day {v1_day}, v2 local_day {event.local_day}")

    meal_items: dict[str, list[dict[str, Any]]] = {}
    for item in sorted(v1["meal_item"], key=lambda i: i["position"]):
        meal_items.setdefault(item["meal_id"], []).append(item)
    recipe_items: dict[str, list[dict[str, Any]]] = {}
    for item in sorted(v1["recipe_item"], key=lambda i: i["position"]):
        recipe_items.setdefault(item["recipe_id"], []).append(item)
    serves = {r["id"]: r["serves"] or 1 for r in v1["recipe"]}

    for meal in sorted(v1["meal"], key=lambda r: r["eaten_at"]):
        mid = meal["id"]
        eaten = meal_items.get(mid, [])

        async def log_meal(meal: dict[str, Any] = meal, mid: str = mid, eaten=eaten) -> Any:
            missing = [i["food_id"] for i in eaten if i["food_id"] not in m.foods]
            if missing:
                raise Skipped(f"foods not migrated: {missing}")
            payload: dict[str, Any] = {"slot": meal["meal_type"], "note": meal["note"]}
            rid = meal["recipe_id"]
            portions = None
            if rid and rid in m.recipes:
                portions = _recipe_portions(eaten, recipe_items.get(rid, []), serves[rid])
            if portions is not None:
                payload |= {"recipe_id": str(m.recipes[rid]), "portions": portions}
            else:
                if rid:
                    m.notes.append(
                        f"meal {mid} ({meal['day']}): items differ from its recipe; logged as items"
                    )
                payload["items"] = [
                    {"food_id": str(m.foods[i["food_id"]]), "grams": i["grams"]} for i in eaten
                ]
            draft = {"kind": "intake", "occurred_at": meal["eaten_at"], "payload": payload}
            event = await m.log(f"v1:meal:{mid}", "intake(meal)", draft)
            m.meals[mid] = event.chain_id
            v1_kcal = sum(i["kcal"] for i in eaten)
            v2_kcal = event.payload["nutrients"]["kcal"]
            if abs(v1_kcal - v2_kcal) > 0.5:
                m.notes.append(
                    f"meal {mid} ({meal['day']}): kcal v1 {v1_kcal:.1f} vs v2 {v2_kcal:.1f}"
                )
            return event

        check_day(f"meal:{mid}", await m.attempt(f"meal:{mid}", log_meal()), meal["day"])

    for drink in sorted(v1["drink"], key=lambda r: r["drunk_at"]):
        ref = drink["food_id"] or f"drink:{drink['name']}"
        if ref not in m.foods:
            m.skipped.append((f"drink:{drink['id']}", f"food {ref} not migrated"))
            continue
        draft = {
            "kind": "intake",
            "occurred_at": drink["drunk_at"],
            "payload": {
                "items": [{"food_id": str(m.foods[ref]), "grams": drink["ml"]}],
                "note": drink["note"],
            },
        }
        event = await m.attempt(
            f"drink:{drink['id']}", m.log(f"v1:drink:{drink['id']}", "intake(drink)", draft)
        )
        check_day(f"drink:{drink['id']}", event, drink["day"])
        if event is not None and abs(event.payload["nutrients"]["kcal"] - drink["kcal"]) > 0.5:
            m.notes.append(
                f"drink {drink['id']} ({drink['name']}): kcal v1 {drink['kcal']} vs v2 "
                f"{event.payload['nutrients']['kcal']}"
            )

    for row in sorted(v1["medication"], key=lambda r: r["taken_at"]):
        draft = {
            "kind": "medication",
            "occurred_at": row["taken_at"],
            "payload": {
                "name": row["name"],
                "dose": row["dose"],
                "unit": row["unit"],
                "note": row["note"],
            },
        }
        event = await m.attempt(
            f"medication:{row['id']} {row['name']} dose={row['dose']} unit={row['unit']}",
            m.log(f"v1:medication:{row['id']}", "medication", draft),
        )
        check_day(f"medication:{row['id']}", event, row["day"])

    for row in sorted(v1["sleep"], key=lambda r: r["started_at"]):
        draft = {
            "kind": "sleep",
            "occurred_at": row["started_at"],
            "ends_at": row["ended_at"],
            "payload": {"quality": row["quality"], "note": row["note"]},
        }
        event = await m.attempt(
            f"sleep:{row['id']}", m.log(f"v1:sleep:{row['id']}", "sleep", draft)
        )
        if event is not None and event.local_day != date.fromisoformat(row["day"]):
            m.notes.append(
                f"sleep {row['id']}: v1 day {row['day']} (wake-up day), v2 local_day "
                f"{event.local_day} (fall-asleep day); the v2 day view counts it on the wake-up day"
            )

    async def companion_note(table: str, row: dict[str, Any], occurred_at: str, target) -> None:
        if not row["note"] or target is None:
            return
        draft = {
            "kind": "note",
            "occurred_at": occurred_at,
            "payload": {"text": row["note"]},
            "links": [{"to_chain": str(target.chain_id), "relation": "part_of"}],
        }
        await m.attempt(
            f"{table}-note:{row['id']}", m.log(f"v1:{table}:{row['id']}:note", "note", draft)
        )

    for row in sorted(v1["steps"], key=lambda r: r["recorded_at"]):
        start = day_bounds(date.fromisoformat(row["day"]), tz)[0]
        ends = ts(row["recorded_at"])
        if ends < start:
            ends = day_bounds(date.fromisoformat(row["day"]), tz)[1]
        draft = {
            "kind": "activity",
            "occurred_at": start.isoformat(),
            "ends_at": ends.isoformat(),
            "payload": {"steps": row["count"]},
        }
        event = await m.attempt(
            f"steps:{row['id']}", m.log(f"v1:steps:{row['id']}", "activity(steps)", draft)
        )
        check_day(f"steps:{row['id']}", event, row["day"])
        await companion_note("steps", row, row["recorded_at"], event)

    for row in sorted(v1["bowel_movement"], key=lambda r: r["occurred_at"]):
        draft = {
            "kind": "outtake",
            "occurred_at": row["occurred_at"],
            "payload": {"bristol": row["bristol"], "note": row["note"]},
        }
        event = await m.attempt(
            f"bowel_movement:{row['id']}",
            m.log(f"v1:bowel_movement:{row['id']}", "outtake", draft),
        )
        check_day(f"bowel_movement:{row['id']}", event, row["day"])

    for row in sorted(v1["body_check"], key=lambda r: r["measured_at"]):
        first = None
        for column, metric in BODY_METRICS.items():
            if row[column] is None:
                continue
            draft = {
                "kind": "measurement",
                "occurred_at": row["measured_at"],
                "payload": {"metric": metric, "value": row[column]},
            }
            event = await m.attempt(
                f"body_check:{row['id']}:{metric}",
                m.log(f"v1:body_check:{row['id']}:{metric}", "measurement", draft),
            )
            check_day(f"body_check:{row['id']}", event, row["day"])
            first = first or event
        await companion_note("body_check", row, row["measured_at"], first)

    for row in sorted(v1["day_checkin"], key=lambda r: r["recorded_at"]):
        draft = {
            "kind": "checkin",
            "occurred_at": row["recorded_at"],
            "payload": {
                "overall": row["overall"],
                "energy": row["energy"],
                "mood": row["mood"],
                "note": row["note"],
            },
        }
        event = await m.attempt(
            f"day_checkin:{row['id']}", m.log(f"v1:day_checkin:{row['id']}", "checkin", draft)
        )
        check_day(f"day_checkin:{row['id']}", event, row["day"])

    for row in sorted(v1["feeling"], key=lambda r: r["occurred_at"]):
        links = []
        if row["meal_id"]:
            if row["meal_id"] in m.meals:
                relation = "follows" if row["kind"] == "good" else "suspected_cause"
                links.append({"to_chain": str(m.meals[row["meal_id"]]), "relation": relation})
            else:
                m.notes.append(f"feeling {row['id']}: meal {row['meal_id']} not migrated, no link")
        note = row["note"]
        if row["food_id"]:
            food = by_id.get(row["food_id"], {}).get("name", row["food_id"])
            note = f"{note}\nSuspected food: {food}" if note else f"Suspected food: {food}"
        if row["kind"] == "good" and row["severity"] is not None:
            tally = "checkin(feeling good)"
            draft = {
                "kind": "checkin",
                "occurred_at": row["occurred_at"],
                "payload": {"overall": row["severity"], "note": note},
            }
        elif row["kind"] == "good":
            tally = "note(feeling good)"
            text = f"Feeling good: {note}" if note else "Feeling good"
            draft = {"kind": "note", "occurred_at": row["occurred_at"], "payload": {"text": text}}
        else:
            tally = "symptom"
            draft = {
                "kind": "symptom",
                "occurred_at": row["occurred_at"],
                "payload": {"type": row["kind"], "severity": row["severity"], "note": note},
            }
        draft["links"] = links
        event = await m.attempt(
            f"feeling:{row['id']} {row['kind']}", m.log(f"v1:feeling:{row['id']}", tally, draft)
        )
        check_day(f"feeling:{row['id']}", event, row["day"])
    return day_mismatch


async def spot_check(m: Migration, v1: dict[str, list[dict[str, Any]]]) -> list[str]:
    meal_day = {r["id"]: r["day"] for r in v1["meal"]}
    totals: dict[str, list[float]] = {}
    for item in v1["meal_item"]:
        t = totals.setdefault(meal_day[item["meal_id"]], [0.0, 0.0])
        t[0] += item["kcal"]
        t[1] += item["protein_g"] or 0
    for drink in v1["drink"]:
        t = totals.setdefault(drink["day"], [0.0, 0.0])
        t[0] += drink["kcal"]
        t[1] += drink["protein_g"] or 0
    lines = []
    for day in sorted(totals):
        view = await m.query("get_day", {"date": day})
        n = view.summary.nutrients
        v1_kcal, v1_protein = totals[day]
        ok = abs(n.kcal - v1_kcal) <= 1 and abs(n.protein_g - v1_protein) <= 0.5
        lines.append(
            f"{day}: v1 {v1_kcal:.1f} kcal / {v1_protein:.1f} g protein | v2 view "
            f"{n.kcal:.1f} kcal / {n.protein_g:.1f} g protein | "
            f"fluid {n.fluid_ml:.0f} ml | {'OK' if ok else 'DIFF'}"
        )
    return lines


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("export", type=Path, help="directory with the v1 <table>.json files")
    parser.add_argument("--dry-run", action="store_true", help="roll everything back at the end")
    args = parser.parse_args()
    v1 = load(args.export)
    settings = get_settings()
    if not settings.owner_sub:
        print("OWNER_SUB is not set", file=sys.stderr)
        return 2
    principal = Principal(sub=settings.owner_sub, client_id="migrate-v1", source="system")
    try:
        async with open_session() as session:
            m = Migration(session, principal)
            await migrate_profile(m, v1["profile"])
            await migrate_catalog(m, v1)
            mismatch = await migrate_journal(m, v1)
            await session.flush()
            checks = await spot_check(m, v1)
            if args.dry_run:
                await session.rollback()
            else:
                await session.commit()
    finally:
        await services.aclose()
        await dispose_engine()

    print(f"mode: {'DRY RUN (rolled back)' if args.dry_run else 'COMMITTED'}")
    print(f"v1 rows: { {t: len(rows) for t, rows in v1.items()} }")
    print(f"created: {dict(sorted(m.created.items()))}")
    print(f"replayed (already migrated): {dict(sorted(m.replayed.items()))}")
    print(f"skipped: {len(m.skipped)}")
    for label, reason in m.skipped:
        print(f"  SKIP {label}: {reason}")
    print(f"notes: {len(m.notes)}")
    for note in m.notes:
        print(f"  NOTE {note}")
    print(f"local_day differs from v1 day: {len(mismatch)}")
    for line in mismatch:
        print(f"  DAY {line}")
    print("day totals, v1 vs v2 get_day:")
    for line in checks:
        print(f"  {line}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
