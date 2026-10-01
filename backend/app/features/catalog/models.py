"""Catalog tables and the models only the catalog feature defines."""

import uuid
from datetime import datetime
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base, CreatedAtMixin
from app.helpers.models import CommandInput, Nutrients, QueryInput, StrictModel

FoodKind = Literal["food", "drink"]


class Food(Base, CreatedAtMixin):
    """A food or drink; its nutrients live in versions."""

    __tablename__ = "food"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(sa.String(300))
    brand: Mapped[str | None] = mapped_column(sa.String(300))
    barcode: Mapped[str | None] = mapped_column(sa.String(64), unique=True)
    kind: Mapped[str] = mapped_column(sa.String(10))
    source: Mapped[str] = mapped_column(sa.String(10))
    unit_name: Mapped[str | None] = mapped_column(sa.String(32))
    unit_grams: Mapped[float | None]
    pack_grams: Mapped[float | None]
    archived_at: Mapped[datetime | None]


class FoodVersion(Base):
    """Nutrients per 100 g/ml of a food from `valid_from` on."""

    __tablename__ = "food_version"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    food_id: Mapped[uuid.UUID] = mapped_column(sa.ForeignKey("food.id"), index=True)
    valid_from: Mapped[datetime]
    kcal: Mapped[float]
    protein_g: Mapped[float | None]
    carbs_g: Mapped[float | None]
    fat_g: Mapped[float | None]
    fiber_g: Mapped[float | None]
    sugar_g: Mapped[float | None]
    salt_g: Mapped[float | None]
    source_note: Mapped[str | None] = mapped_column(sa.String(300))


class Recipe(Base, CreatedAtMixin):
    """A recipe; its content lives in versions."""

    __tablename__ = "recipe"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(sa.String(200))
    archived_at: Mapped[datetime | None]


class RecipeVersion(Base):
    """A recipe's items, portions and steps from `valid_from` on."""

    __tablename__ = "recipe_version"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    recipe_id: Mapped[uuid.UUID] = mapped_column(sa.ForeignKey("recipe.id"), index=True)
    valid_from: Mapped[datetime]
    serves: Mapped[int]
    steps: Mapped[list[Any]]
    items: Mapped[list[Any]]
    note: Mapped[str | None] = mapped_column(sa.Text)


class Per100(StrictModel):
    """Nutrient facts per 100 g (or 100 ml for drinks)."""

    kcal: float = Field(ge=0, le=1000)
    protein_g: float | None = Field(default=None, ge=0, le=100)
    carbs_g: float | None = Field(default=None, ge=0, le=100)
    fat_g: float | None = Field(default=None, ge=0, le=100)
    fiber_g: float | None = Field(default=None, ge=0, le=100)
    sugar_g: float | None = Field(default=None, ge=0, le=100)
    salt_g: float | None = Field(default=None, ge=0, le=100)

    def for_grams(self, grams: float, kind: str) -> Nutrients:
        """Absolute amounts in `grams` of this food; drinks also count as fluid."""
        factor = grams / 100
        return Nutrients(
            kcal=round(self.kcal * factor, 2),
            protein_g=round((self.protein_g or 0) * factor, 2),
            carbs_g=round((self.carbs_g or 0) * factor, 2),
            fat_g=round((self.fat_g or 0) * factor, 2),
            fiber_g=round((self.fiber_g or 0) * factor, 2),
            sugar_g=round((self.sugar_g or 0) * factor, 2),
            salt_g=round((self.salt_g or 0) * factor, 2),
            fluid_ml=round(grams, 2) if kind == "drink" else 0,
        )


class FoodOut(BaseModel):
    """A food with its current nutrients."""

    id: uuid.UUID
    name: str
    brand: str | None
    barcode: str | None
    kind: FoodKind
    source: Literal["off", "manual"]
    unit_name: str | None
    unit_grams: float | None
    pack_grams: float | None
    archived: bool
    version_id: uuid.UUID
    per_100: Per100
    versions: int


class FoodSave(CommandInput):
    """Create a food (without id) or change one (with id); a change touches only the fields sent."""

    id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=300)
    brand: str | None = Field(default=None, max_length=300)
    kind: FoodKind | None = None
    unit_name: str | None = Field(
        default=None, min_length=1, max_length=32, description="e.g. Stück"
    )
    unit_grams: float | None = Field(default=None, gt=0, le=5000)
    pack_grams: float | None = Field(default=None, gt=0, le=100000)
    per_100: Per100 | None = Field(default=None, description="New nutrients create a new version.")

    @field_validator("name", "kind")
    @classmethod
    def _not_null(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            raise ValueError(f"{info.field_name} cannot be null")
        return value

    @model_validator(mode="after")
    def _unit_pair(self) -> FoodSave:
        sent = {"unit_name", "unit_grams"} & self.model_fields_set
        if len(sent) == 1 or (self.unit_name is None) != (self.unit_grams is None):
            raise ValueError("unit_name and unit_grams go together")
        return self


class FoodImport(CommandInput):
    """Add a product from Open Food Facts by barcode (or return it if already known)."""

    barcode: str = Field(pattern=r"^[0-9]{4,32}$")


class FoodSearch(QueryInput):
    """Search the local catalog and Open Food Facts."""

    q: str = Field(min_length=2, max_length=100)


class RemoteFood(BaseModel):
    """An Open Food Facts hit not yet in the catalog; import it with import_food."""

    barcode: str
    name: str
    brand: str | None
    per_100: Per100 | None
    usable: bool


class FoodSearchOut(BaseModel):
    """Local foods first, then remote hits; an outage leaves the local hits intact."""

    local: list[FoodOut]
    remote: list[RemoteFood]
    remote_error: str | None = None


class RecipeItemIn(StrictModel):
    """One ingredient."""

    food_id: uuid.UUID
    grams: float = Field(gt=0, le=5000)


class RecipeSave(CommandInput):
    """Create a recipe (without id) or add a new version of one (with id)."""

    id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    serves: int = Field(default=1, ge=1, le=50, description="Portions the items make.")
    steps: list[str] = Field(default_factory=list, max_length=50)
    items: list[RecipeItemIn] = Field(min_length=1, max_length=60)
    note: str | None = Field(default=None, max_length=2000)


class RecipeItemOut(BaseModel):
    """An ingredient with its current nutrients."""

    food_id: uuid.UUID
    name: str
    grams: float
    unit_name: str | None
    unit_grams: float | None
    nutrients: Nutrients


class RecipeOut(BaseModel):
    """A recipe's current version."""

    id: uuid.UUID
    name: str
    version_id: uuid.UUID
    serves: int
    steps: list[str]
    items: list[RecipeItemOut]
    totals: Nutrients
    per_portion: Nutrients
    note: str | None
    archived: bool
    versions: int


class RecipeListQuery(QueryInput):
    """List recipes."""

    include_archived: bool = False


class RecipeSummary(BaseModel):
    """A recipe in a list."""

    id: uuid.UUID
    name: str
    serves: int
    per_portion: Nutrients
    archived: bool


class RecipeList(BaseModel):
    """Recipes by name."""

    recipes: list[RecipeSummary]


class SnapshotItem(BaseModel):
    """An eaten amount of a food, with its nutrients frozen at that food version."""

    food_id: uuid.UUID
    food_version_id: uuid.UUID
    name: str
    kind: FoodKind
    grams: float
    nutrients: Nutrients
