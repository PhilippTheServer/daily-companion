import pytest

from app.features.catalog.exceptions import FoodNotFound
from app.features.catalog.functions import snapshot
from app.helpers.services import services
from tests.clients import call_tool
from tests.conftest import requires_db
from tests.features.catalog.fakes import FakeOff

pytestmark = requires_db


@pytest.fixture(autouse=True)
def off():
    fake = FakeOff()
    services.override("openfoodfacts", fake)
    return fake


async def _manual(rest, **overrides):
    body = {
        "name": "Eier",
        "unit_name": "Stück",
        "unit_grams": 58,
        "per_100": {"kcal": 143, "protein_g": 12.6, "fat_g": 9.9},
    } | overrides
    return (await rest.post("/api/v2/commands/save_food", json=body)).json()["result"]


async def test_import_food_caches_an_open_food_facts_product_once(rest):
    first = (
        await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})
    ).json()["result"]
    again = (
        await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})
    ).json()["result"]
    assert first["id"] == again["id"]
    assert (first["source"], first["per_100"]["kcal"], first["versions"]) == ("off", 62, 1)


async def test_import_food_errors(rest, off):
    missing = await rest.post("/api/v2/commands/import_food", json={"barcode": "999999"})
    assert (missing.status_code, missing.json()["code"], missing.json()["field"]) == (
        404,
        "not_found",
        "barcode",
    )
    empty = await rest.post("/api/v2/commands/import_food", json={"barcode": "1111"})
    assert (empty.status_code, empty.json()["field"]) == (422, "barcode")
    off.down = True
    down = await rest.post("/api/v2/commands/import_food", json={"barcode": "22130112"})
    assert (down.status_code, down.json()["code"]) == (503, "upstream")


async def test_save_food_creates_updates_and_versions_nutrients(rest):
    food = await _manual(rest)
    assert (food["source"], food["versions"], food["unit_grams"]) == ("manual", 1, 58)
    renamed = (
        await rest.post(
            "/api/v2/commands/save_food", json={"id": food["id"], "name": "Freiland Eier"}
        )
    ).json()["result"]
    assert (renamed["name"], renamed["unit_name"], renamed["versions"]) == (
        "Freiland Eier",
        "Stück",
        1,
    )
    corrected = (
        await rest.post(
            "/api/v2/commands/save_food", json={"id": food["id"], "per_100": {"kcal": 150}}
        )
    ).json()["result"]
    assert (corrected["per_100"]["kcal"], corrected["versions"]) == (150, 2)
    same = (
        await rest.post(
            "/api/v2/commands/save_food", json={"id": food["id"], "per_100": {"kcal": 150}}
        )
    ).json()["result"]
    assert same["versions"] == 2


async def test_save_food_rejects_explicit_nulls(rest):
    food = await _manual(rest)
    cases = [
        ({"id": food["id"], "name": None}, "name"),
        ({"id": food["id"], "kind": None}, "kind"),
        ({"name": "X", "kind": None, "per_100": {"kcal": 1}}, "kind"),
    ]
    for body, field in cases:
        response = await rest.post("/api/v2/commands/save_food", json=body)
        assert (response.status_code, response.json()["field"]) == (422, field), body


async def test_save_food_errors(rest):
    no_nutrients = await rest.post("/api/v2/commands/save_food", json={"name": "Salz"})
    assert (no_nutrients.status_code, no_nutrients.json()["field"]) == (422, "per_100")
    no_name = await rest.post("/api/v2/commands/save_food", json={"per_100": {"kcal": 0}})
    assert (no_name.status_code, no_name.json()["field"]) == (422, "name")
    half_unit = await rest.post(
        "/api/v2/commands/save_food",
        json={"name": "X", "unit_name": "Stück", "per_100": {"kcal": 1}},
    )
    assert half_unit.status_code == 422
    unknown = await rest.post(
        "/api/v2/commands/save_food",
        json={"id": "00000000-0000-0000-0000-000000000001", "name": "X"},
    )
    assert (unknown.status_code, unknown.json()["code"]) == (404, "not_found")


async def test_archived_foods_cannot_be_edited_and_leave_search(rest):
    food = await _manual(rest, name="Knoblauch")
    await rest.post("/api/v2/commands/archive_food", json={"id": food["id"]})
    edit = await rest.post("/api/v2/commands/save_food", json={"id": food["id"], "name": "K"})
    assert (edit.status_code, edit.json()["code"]) == (409, "conflict")
    found = (await rest.get("/api/v2/views/catalog", params={"q": "Knob"})).json()
    assert found["local"] == []


async def test_find_food_merges_local_and_remote_and_survives_an_outage(rest, off):
    await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})
    both = (await rest.get("/api/v2/views/catalog", params={"q": "Mil"})).json()
    assert [f["name"] for f in both["remote"]] == ["Milch 1,5%"]
    skyr = (await rest.get("/api/v2/views/catalog", params={"q": "Skyr"})).json()
    assert [f["name"] for f in skyr["local"]] == ["Skyr"]
    assert skyr["remote"] == []
    off.down = True
    outage = (await rest.get("/api/v2/views/catalog", params={"q": "Skyr"})).json()
    assert outage["remote_error"] == "Open Food Facts did not answer"
    assert len(outage["local"]) == 1


async def test_get_food_view_and_snapshot(rest, db):
    food = await _manual(rest)
    view = (await rest.get("/api/v2/views/food", params={"id": food["id"]})).json()
    assert view["name"] == "Eier"
    items = await snapshot(db, [(food["id"], 116)])
    assert (
        items[0].name,
        items[0].grams,
        items[0].nutrients.kcal,
        items[0].nutrients.fluid_ml,
    ) == ("Eier", 116, 165.88, 0)
    with pytest.raises(FoodNotFound) as caught:
        await snapshot(db, [("00000000-0000-0000-0000-000000000009", 10)])
    assert caught.value.field == "items.0.food_id"


async def test_find_food_through_mcp(mcp):
    async with mcp() as client:
        body = await call_tool(client, "find_food", {"q": "Skyr"})
    assert body["remote"][0]["usable"] is True


async def test_archived_off_food_returns_as_remote_and_import_revives_it(rest):
    imported = (
        await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})
    ).json()["result"]
    await rest.post("/api/v2/commands/archive_food", json={"id": imported["id"]})
    found = (await rest.get("/api/v2/views/catalog", params={"q": "Skyr"})).json()
    assert (found["local"], [f["barcode"] for f in found["remote"]]) == ([], ["4056489012788"])
    revived = (
        await rest.post("/api/v2/commands/import_food", json={"barcode": "4056489012788"})
    ).json()["result"]
    assert (revived["id"], revived["archived"]) == (imported["id"], False)
    again = (await rest.get("/api/v2/views/catalog", params={"q": "Skyr"})).json()
    assert ([f["name"] for f in again["local"]], again["remote"]) == (["Skyr"], [])


async def test_find_food_treats_like_wildcards_literally(rest):
    await _manual(rest, name="12")
    await _manual(rest, name="50% Mix")
    hits = (await rest.get("/api/v2/views/catalog", params={"q": "1%"})).json()
    assert hits["local"] == []
    hits = (await rest.get("/api/v2/views/catalog", params={"q": "0% "})).json()
    assert [f["name"] for f in hits["local"]] == ["50% Mix"]


async def test_save_food_over_mcp_creates_and_updates(rest, mcp):
    async with mcp() as client:
        created = await call_tool(
            client,
            "save_food",
            {"name": "Skyr", "kind": "food", "per_100": {"kcal": 62, "protein_g": 11}},
        )
        food = created["result"]
        assert (food["name"], food["kind"]) == ("Skyr", "food")
        renamed = await call_tool(client, "save_food", {"id": food["id"], "name": "Skyr Natur"})
    assert renamed["result"]["name"] == "Skyr Natur"
    assert renamed["result"]["per_100"]["kcal"] == 62
