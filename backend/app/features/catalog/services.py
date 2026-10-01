"""Open Food Facts: product search and barcode lookup, normalised into OffProduct."""

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from app.features.catalog.models import Per100
from app.helpers.config import get_settings
from app.helpers.errors import Upstream
from app.helpers.services import services

_FIELDS = "code,product_name,product_name_de,product_name_en,brands,nutriments"
_KJ_PER_KCAL = 4.184


@dataclass(frozen=True)
class OffProduct:
    """A product as Open Food Facts describes it; per_100 is None when unusable."""

    barcode: str
    name: str
    brand: str | None
    per_100: Per100 | None


def _number(nutriments: dict[str, Any], key: str) -> float | None:
    try:
        return float(nutriments[key])
    except KeyError, TypeError, ValueError:
        return None


def _brand(brands: Any) -> str | None:
    if isinstance(brands, list):
        return str(brands[0]) if brands else None
    if isinstance(brands, str) and brands.strip():
        return brands.split(",")[0].strip()
    return None


def parse_product(raw: dict[str, Any]) -> OffProduct:
    """Normalise a search hit or a product payload."""
    barcode = str(raw.get("code") or "")
    name = (
        raw.get("product_name")
        or raw.get("product_name_de")
        or raw.get("product_name_en")
        or barcode
    )
    nutriments = raw.get("nutriments") or {}
    kcal = _number(nutriments, "energy-kcal_100g")
    if kcal is None and (kilojoules := _number(nutriments, "energy_100g")) is not None:
        kcal = round(kilojoules / _KJ_PER_KCAL, 1)
    per_100 = None
    if kcal is not None:
        try:
            per_100 = Per100(
                kcal=kcal,
                protein_g=_number(nutriments, "proteins_100g"),
                carbs_g=_number(nutriments, "carbohydrates_100g"),
                fat_g=_number(nutriments, "fat_100g"),
                fiber_g=_number(nutriments, "fiber_100g"),
                sugar_g=_number(nutriments, "sugars_100g"),
                salt_g=_number(nutriments, "salt_100g"),
            )
        except ValidationError:
            per_100 = None
    return OffProduct(
        barcode=barcode, name=str(name), brand=_brand(raw.get("brands")), per_100=per_100
    )


class OpenFoodFactsClient:
    """Search and product lookup; every failure is an Upstream error."""

    def __init__(
        self, http: httpx.AsyncClient, search_url: str, product_url: str, user_agent: str
    ) -> None:
        self._http = http
        self._search_url = search_url
        self._product_url = product_url
        self._headers = {"User-Agent": user_agent}

    async def _get(self, url: str, params: dict[str, Any]) -> httpx.Response:
        try:
            return await self._http.get(url, params=params, headers=self._headers, timeout=10)
        except httpx.HTTPError as exc:
            raise Upstream("Open Food Facts did not answer") from exc

    @staticmethod
    def _json(response: httpx.Response) -> Any:
        if response.is_error:
            raise Upstream(f"Open Food Facts answered {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise Upstream("Open Food Facts answered with invalid JSON") from exc

    async def search(self, query: str, size: int = 20) -> list[OffProduct]:
        """Products matching a text query."""
        body = self._json(
            await self._get(
                self._search_url,
                {"q": query, "langs": "de,en", "page_size": size, "fields": _FIELDS},
            )
        )
        hits = body.get("hits") if isinstance(body, dict) else None
        return [parse_product(hit) for hit in hits or [] if isinstance(hit, dict)]

    async def get_product(self, barcode: str) -> OffProduct | None:
        """One product by barcode, or None if Open Food Facts does not know it."""
        response = await self._get(
            f"{self._product_url}/{quote(barcode, safe='')}", {"fields": _FIELDS}
        )
        if response.status_code == 404:
            return None
        body = self._json(response)
        product = (
            body.get("product") if isinstance(body, dict) and body.get("status") == 1 else None
        )
        return parse_product(product) if isinstance(product, dict) else None

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._http.aclose()


def _build() -> OpenFoodFactsClient:
    settings = get_settings()
    return OpenFoodFactsClient(
        httpx.AsyncClient(),
        settings.off_search_url,
        settings.off_product_url,
        settings.off_user_agent,
    )


services.register("openfoodfacts", _build)


def openfoodfacts() -> OpenFoodFactsClient:
    """The Open Food Facts client in use."""
    return services.get("openfoodfacts")
