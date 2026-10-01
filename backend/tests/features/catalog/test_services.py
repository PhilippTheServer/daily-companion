import httpx
import pytest

from app.features.catalog.services import OpenFoodFactsClient, parse_product
from app.helpers.errors import Upstream


def test_parse_product_reads_kcal_or_converts_kilojoules():
    direct = parse_product(
        {
            "code": "1",
            "product_name": "A",
            "brands": "X, Y",
            "nutriments": {"energy-kcal_100g": 100, "proteins_100g": "7.5"},
        }
    )
    assert (direct.name, direct.brand, direct.per_100.kcal, direct.per_100.protein_g) == (
        "A",
        "X",
        100,
        7.5,
    )
    converted = parse_product(
        {"code": "2", "product_name_de": "B", "brands": ["Z"], "nutriments": {"energy_100g": 418.4}}
    )
    assert (converted.name, converted.brand, converted.per_100.kcal) == ("B", "Z", 100)


def test_parse_product_without_energy_or_with_nonsense_has_no_nutrients():
    assert parse_product({"code": "3", "nutriments": {}}).per_100 is None
    assert parse_product({"code": "4", "nutriments": {"energy-kcal_100g": 99999}}).per_100 is None
    assert parse_product({"code": "5"}).name == "5"


async def test_client_search_product_and_failures():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["user-agent"].startswith("daily2")
        if request.url.path == "/search":
            return httpx.Response(
                200,
                json={
                    "hits": [
                        {
                            "code": "9",
                            "product_name": "Skyr",
                            "nutriments": {"energy-kcal_100g": 62},
                        }
                    ]
                },
            )
        if request.url.path.endswith("/9"):
            return httpx.Response(
                200,
                json={
                    "status": 1,
                    "product": {
                        "code": "9",
                        "product_name": "Skyr",
                        "nutriments": {"energy-kcal_100g": 62},
                    },
                },
            )
        if request.url.path.endswith("/404"):
            return httpx.Response(404, json={"status": 0})
        return httpx.Response(500)

    client = OpenFoodFactsClient(
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        "http://off/search",
        "http://off/api/v2/product",
        "daily2 test",
    )
    assert [p.barcode for p in await client.search("skyr")] == ["9"]
    assert (await client.get_product("9")).name == "Skyr"
    assert await client.get_product("404") is None
    with pytest.raises(Upstream):
        await client.get_product("500")
    await client.aclose()
