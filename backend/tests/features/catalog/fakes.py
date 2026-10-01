"""An in-memory Open Food Facts stand-in."""

from app.features.catalog.models import Per100
from app.features.catalog.services import OffProduct
from app.helpers.errors import Upstream

SKYR = OffProduct(
    barcode="4056489012788",
    name="Skyr",
    brand="Milbona",
    per_100=Per100(kcal=62, protein_g=11, carbs_g=4, fat_g=0.2),
)
MILK = OffProduct(
    barcode="22130112",
    name="Milch 1,5%",
    brand="Milfina",
    per_100=Per100(kcal=46, protein_g=3.4, carbs_g=4.8, fat_g=1.5),
)
NO_DATA = OffProduct(barcode="1111", name="Mystery", brand=None, per_100=None)


class FakeOff:
    """Serves fixed products; `down=True` fails every call like an outage."""

    def __init__(self, products: list[OffProduct] | None = None, down: bool = False) -> None:
        self.products = {p.barcode: p for p in (products or [SKYR, MILK, NO_DATA])}
        self.down = down

    async def search(self, query: str, size: int = 20) -> list[OffProduct]:
        if self.down:
            raise Upstream("Open Food Facts did not answer")
        return [p for p in self.products.values() if query.lower() in p.name.lower()]

    async def get_product(self, barcode: str) -> OffProduct | None:
        if self.down:
            raise Upstream("Open Food Facts did not answer")
        return self.products.get(barcode)
