import pytest
from sqlalchemy import event

from app.features.catalog.functions import recipe_items
from tests.conftest import requires_db

pytestmark = requires_db


async def _food(rest, name, kcal, protein=0.0):
    body = {"name": name, "per_100": {"kcal": kcal, "protein_g": protein}}
    return (await rest.post("/api/v2/commands/save_food", json=body)).json()["result"]


@pytest.fixture
async def bowl(rest):
    chicken = await _food(rest, "Hähnchen", 110, 23)
    rice = await _food(rest, "Reis", 350, 7)
    body = {
        "name": "Bowl",
        "serves": 2,
        "steps": ["Kochen", "Braten"],
        "items": [{"food_id": chicken["id"], "grams": 300}, {"food_id": rice["id"], "grams": 140}],
    }
    recipe = (await rest.post("/api/v2/commands/save_recipe", json=body)).json()["result"]
    return recipe, chicken, rice


async def test_recipe_totals_and_per_portion(bowl):
    recipe, _, _ = bowl
    assert recipe["totals"]["kcal"] == 820
    assert recipe["per_portion"]["kcal"] == 410
    assert recipe["steps"] == ["Kochen", "Braten"]
    assert recipe["versions"] == 1


async def test_saving_again_adds_a_version(rest, bowl):
    recipe, chicken, _ = bowl
    body = {
        "id": recipe["id"],
        "name": "Bowl",
        "serves": 1,
        "items": [{"food_id": chicken["id"], "grams": 150}],
    }
    updated = (await rest.post("/api/v2/commands/save_recipe", json=body)).json()["result"]
    assert (updated["versions"], updated["totals"]["kcal"]) == (2, 165)


async def test_recipe_errors(rest, bowl):
    recipe, chicken, _ = bowl
    unknown_food = await rest.post(
        "/api/v2/commands/save_recipe",
        json={
            "name": "X",
            "items": [{"food_id": "00000000-0000-0000-0000-000000000009", "grams": 1}],
        },
    )
    assert (unknown_food.status_code, unknown_food.json()["field"]) == (404, "items.0.food_id")
    await rest.post("/api/v2/commands/archive_food", json={"id": chicken["id"]})
    archived_food = await rest.post(
        "/api/v2/commands/save_recipe",
        json={"name": "X", "items": [{"food_id": chicken["id"], "grams": 1}]},
    )
    assert (archived_food.status_code, archived_food.json()["field"]) == (409, "items.0.food_id")
    await rest.post("/api/v2/commands/archive_recipe", json={"id": recipe["id"]})
    edit = await rest.post(
        "/api/v2/commands/save_recipe",
        json={"id": recipe["id"], "name": "B", "items": [{"food_id": chicken["id"], "grams": 1}]},
    )
    assert edit.status_code == 409
    missing = await rest.get(
        "/api/v2/views/recipe", params={"id": "00000000-0000-0000-0000-000000000009"}
    )
    assert missing.status_code == 404


async def test_list_recipes_hides_archived_unless_asked(rest, bowl):
    recipe, _, _ = bowl
    assert [r["name"] for r in (await rest.get("/api/v2/views/recipes")).json()["recipes"]] == [
        "Bowl"
    ]
    await rest.post("/api/v2/commands/archive_recipe", json={"id": recipe["id"]})
    assert (await rest.get("/api/v2/views/recipes")).json()["recipes"] == []
    all_recipes = (
        await rest.get("/api/v2/views/recipes", params={"include_archived": True})
    ).json()["recipes"]
    assert all_recipes[0]["archived"] is True


async def test_recipe_items_scale_to_portions(db, bowl):
    recipe, chicken, _ = bowl
    version_id, items = await recipe_items(db, recipe["id"], portions=1)
    assert str(version_id) == recipe["version_id"]
    assert (str(items[0][0]), items[0][1]) == (chicken["id"], 150)


async def _select_count(rest, db):
    statements = []

    def record(conn, cursor, statement, *args):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    connection = db.sync_session.bind
    event.listen(connection, "before_cursor_execute", record)
    try:
        assert (await rest.get("/api/v2/views/recipes")).status_code == 200
    finally:
        event.remove(connection, "before_cursor_execute", record)
    return len(statements)


async def test_list_recipes_query_count_does_not_grow_with_recipes(rest, db):
    async def add(name):
        foods = [await _food(rest, f"{name}-{i}", 100) for i in range(2)]
        items = [{"food_id": f["id"], "grams": 50} for f in foods]
        await rest.post("/api/v2/commands/save_recipe", json={"name": name, "items": items})

    await add("R0")
    one = await _select_count(rest, db)
    await add("R1")
    await add("R2")
    three = await _select_count(rest, db)
    assert one > 0
    assert three == one
