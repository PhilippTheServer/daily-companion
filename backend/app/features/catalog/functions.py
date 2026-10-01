"""Catalog logic: foods and recipes, their versions, search, and nutrient snapshots."""

import uuid
from collections.abc import Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from app.features.catalog.exceptions import (
    FoodArchived,
    FoodNotFound,
    MissingForCreate,
    NoNutritionData,
    NotOnOpenFoodFacts,
    RecipeArchived,
    RecipeNotFound,
)
from app.features.catalog.models import (
    Food,
    FoodImport,
    FoodOut,
    FoodSave,
    FoodSearch,
    FoodSearchOut,
    FoodVersion,
    Per100,
    Recipe,
    RecipeItemOut,
    RecipeList,
    RecipeListQuery,
    RecipeOut,
    RecipeSave,
    RecipeSummary,
    RecipeVersion,
    RemoteFood,
    SnapshotItem,
)
from app.features.catalog.services import openfoodfacts
from app.helpers.endpoints import Context
from app.helpers.errors import Upstream
from app.helpers.models import ById, ByIdCommand, Nutrients
from app.helpers.responses import Outcome

_NUTRIENT_COLUMNS = ("kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "salt_g")
_FOOD_COLUMNS = ("name", "brand", "kind", "unit_name", "unit_grams", "pack_grams")


def _per_100(version: FoodVersion) -> Per100:
    return Per100(**{name: getattr(version, name) for name in _NUTRIENT_COLUMNS})


async def _latest_food_versions(
    session: AsyncSession, food_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, FoodVersion]:
    rows = await session.scalars(
        select(FoodVersion)
        .ext(distinct_on(FoodVersion.food_id))
        .where(FoodVersion.food_id.in_(food_ids))
        .order_by(FoodVersion.food_id, FoodVersion.valid_from.desc())
    )
    return {row.food_id: row for row in rows}


async def _version_counts(
    session: AsyncSession, column, ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, int]:
    rows = await session.execute(
        select(column, func.count()).where(column.in_(ids)).group_by(column)
    )
    return dict(rows.all())


async def _food_outs(session: AsyncSession, foods: Sequence[Food]) -> list[FoodOut]:
    ids = [food.id for food in foods]
    versions = await _latest_food_versions(session, ids)
    counts = await _version_counts(session, FoodVersion.food_id, ids)
    return [
        FoodOut(
            id=food.id,
            name=food.name,
            brand=food.brand,
            barcode=food.barcode,
            kind=food.kind,
            source=food.source,
            unit_name=food.unit_name,
            unit_grams=food.unit_grams,
            pack_grams=food.pack_grams,
            archived=food.archived_at is not None,
            version_id=versions[food.id].id,
            per_100=_per_100(versions[food.id]),
            versions=counts[food.id],
        )
        for food in foods
    ]


async def _food(session: AsyncSession, food_id: uuid.UUID, field: str = "id") -> Food:
    food = await session.get(Food, food_id)
    if food is None:
        raise FoodNotFound(food_id, field)
    return food


async def _foods_for_items(
    session: AsyncSession, food_ids: Sequence[uuid.UUID], field: str
) -> dict[uuid.UUID, Food]:
    """Every referenced food, each existing and not archived; the field names the bad item."""
    rows = {
        food.id: food for food in await session.scalars(select(Food).where(Food.id.in_(food_ids)))
    }
    for index, food_id in enumerate(food_ids):
        item_field = f"{field}.{index}.food_id"
        if food_id not in rows:
            raise FoodNotFound(food_id, item_field)
        if rows[food_id].archived_at is not None:
            raise FoodArchived(food_id, item_field)
    return rows


def _add_version(ctx: Context, food: Food, per_100: Per100, note: str | None) -> None:
    ctx.session.add(
        FoodVersion(food_id=food.id, valid_from=ctx.now, source_note=note, **per_100.model_dump())
    )


async def import_food(ctx: Context, data: FoodImport) -> Outcome[FoodOut]:
    """Add a product from Open Food Facts, or return it when already in the catalog."""
    existing = await ctx.session.scalar(select(Food).where(Food.barcode == data.barcode))
    if existing is not None and existing.archived_at is not None:
        existing.archived_at = None
        await ctx.session.flush()
    if existing is None:
        product = await openfoodfacts().get_product(data.barcode)
        if product is None:
            raise NotOnOpenFoodFacts(data.barcode)
        if product.per_100 is None:
            raise NoNutritionData(product.name)
        barcode = product.barcode or data.barcode
        existing = await ctx.session.scalar(select(Food).where(Food.barcode == barcode))
        if existing is None:
            existing = Food(
                name=product.name[:300],
                brand=product.brand,
                barcode=barcode,
                kind="food",
                source="off",
            )
            ctx.session.add(existing)
            await ctx.session.flush()
            _add_version(ctx, existing, product.per_100, "Open Food Facts")
            await ctx.session.flush()
    return Outcome((await _food_outs(ctx.session, [existing]))[0])


async def save_food(ctx: Context, data: FoodSave) -> Outcome[FoodOut]:
    """Create a manual food, or change one; new nutrients add a version."""
    changes = data.model_dump(exclude_unset=True, include=set(_FOOD_COLUMNS))
    if data.id is None:
        if data.name is None:
            raise MissingForCreate("name")
        if data.per_100 is None:
            raise MissingForCreate("per_100")
        food = Food(source="manual", **({"kind": "food"} | changes))
        ctx.session.add(food)
        await ctx.session.flush()
        _add_version(ctx, food, data.per_100, None)
    else:
        food = await _food(ctx.session, data.id)
        if food.archived_at is not None:
            raise FoodArchived(food.id)
        for name, value in changes.items():
            setattr(food, name, value)
        current = (await _latest_food_versions(ctx.session, [food.id]))[food.id]
        if data.per_100 is not None and data.per_100 != _per_100(current):
            _add_version(ctx, food, data.per_100, None)
    await ctx.session.flush()
    return Outcome((await _food_outs(ctx.session, [food]))[0])


async def archive_food(ctx: Context, data: ByIdCommand) -> Outcome[FoodOut]:
    """Hide a food from search and new use; history keeps it."""
    food = await _food(ctx.session, data.id)
    if food.archived_at is None:
        food.archived_at = ctx.now
        await ctx.session.flush()
    return Outcome((await _food_outs(ctx.session, [food]))[0])


async def find_food(ctx: Context, data: FoodSearch) -> FoodSearchOut:
    """Local foods matching name or brand, then Open Food Facts hits not yet imported."""
    escaped = data.q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    foods = (
        await ctx.session.scalars(
            select(Food)
            .where(
                Food.archived_at.is_(None),
                or_(Food.name.ilike(pattern, escape="\\"), Food.brand.ilike(pattern, escape="\\")),
            )
            .order_by(Food.name)
            .limit(20)
        )
    ).all()
    local = await _food_outs(ctx.session, foods)
    try:
        products = await openfoodfacts().search(data.q)
    except Upstream as exc:
        return FoodSearchOut(local=local, remote=[], remote_error=exc.message)
    codes = [p.barcode for p in products if p.barcode]
    known = set(
        (
            await ctx.session.scalars(
                select(Food.barcode).where(Food.barcode.in_(codes), Food.archived_at.is_(None))
            )
        ).all()
    )
    remote = [
        RemoteFood(
            barcode=p.barcode,
            name=p.name,
            brand=p.brand,
            per_100=p.per_100,
            usable=p.per_100 is not None,
        )
        for p in products
        if p.barcode and p.barcode not in known
    ]
    return FoodSearchOut(local=local, remote=remote)


async def get_food(ctx: Context, data: ById) -> FoodOut:
    """One food with its current nutrients."""
    return (await _food_outs(ctx.session, [await _food(ctx.session, data.id)]))[0]


async def _recipe(session: AsyncSession, recipe_id: uuid.UUID, field: str = "id") -> Recipe:
    recipe = await session.get(Recipe, recipe_id)
    if recipe is None:
        raise RecipeNotFound(recipe_id, field)
    return recipe


async def _latest_recipe_versions(
    session: AsyncSession, recipe_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, RecipeVersion]:
    rows = await session.scalars(
        select(RecipeVersion)
        .ext(distinct_on(RecipeVersion.recipe_id))
        .where(RecipeVersion.recipe_id.in_(recipe_ids))
        .order_by(RecipeVersion.recipe_id, RecipeVersion.valid_from.desc())
    )
    return {row.recipe_id: row for row in rows}


async def _recipe_items(
    session: AsyncSession, versions: Sequence[RecipeVersion]
) -> dict[uuid.UUID, list[RecipeItemOut]]:
    food_ids = list({uuid.UUID(item["food_id"]) for version in versions for item in version.items})
    foods = {
        food.id: food for food in await session.scalars(select(Food).where(Food.id.in_(food_ids)))
    }
    food_versions = await _latest_food_versions(session, food_ids)
    result = {}
    for version in versions:
        items = []
        for item in version.items:
            food = foods[uuid.UUID(item["food_id"])]
            items.append(
                RecipeItemOut(
                    food_id=food.id,
                    name=food.name,
                    grams=item["grams"],
                    unit_name=food.unit_name,
                    unit_grams=food.unit_grams,
                    nutrients=_per_100(food_versions[food.id]).for_grams(item["grams"], food.kind),
                )
            )
        result[version.id] = items
    return result


async def _recipe_out(session: AsyncSession, recipe: Recipe) -> RecipeOut:
    version = (await _latest_recipe_versions(session, [recipe.id]))[recipe.id]
    items = (await _recipe_items(session, [version]))[version.id]
    totals = Nutrients.total(item.nutrients for item in items)
    counts = await _version_counts(session, RecipeVersion.recipe_id, [recipe.id])
    return RecipeOut(
        id=recipe.id,
        name=recipe.name,
        version_id=version.id,
        serves=version.serves,
        steps=version.steps,
        items=items,
        totals=totals,
        per_portion=totals.scaled(1 / version.serves),
        note=version.note,
        archived=recipe.archived_at is not None,
        versions=counts[recipe.id],
    )


async def save_recipe(ctx: Context, data: RecipeSave) -> Outcome[RecipeOut]:
    """Create a recipe or add a new version; every item's food must exist and be active."""
    await _foods_for_items(ctx.session, [item.food_id for item in data.items], "items")
    if data.id is None:
        recipe = Recipe(name=data.name)
        ctx.session.add(recipe)
        await ctx.session.flush()
    else:
        recipe = await _recipe(ctx.session, data.id)
        if recipe.archived_at is not None:
            raise RecipeArchived(recipe.id)
        recipe.name = data.name
    ctx.session.add(
        RecipeVersion(
            recipe_id=recipe.id,
            valid_from=ctx.now,
            serves=data.serves,
            steps=data.steps,
            items=[{"food_id": str(item.food_id), "grams": item.grams} for item in data.items],
            note=data.note,
        )
    )
    await ctx.session.flush()
    return Outcome(await _recipe_out(ctx.session, recipe))


async def archive_recipe(ctx: Context, data: ByIdCommand) -> Outcome[RecipeOut]:
    """Hide a recipe from lists and new use; history keeps it."""
    recipe = await _recipe(ctx.session, data.id)
    if recipe.archived_at is None:
        recipe.archived_at = ctx.now
        await ctx.session.flush()
    return Outcome(await _recipe_out(ctx.session, recipe))


async def get_recipe(ctx: Context, data: ById) -> RecipeOut:
    """One recipe's current version with totals and per-portion values."""
    return await _recipe_out(ctx.session, await _recipe(ctx.session, data.id))


async def list_recipes(ctx: Context, data: RecipeListQuery) -> RecipeList:
    """Recipes by name, each with its per-portion values."""
    statement = select(Recipe).order_by(Recipe.name)
    if not data.include_archived:
        statement = statement.where(Recipe.archived_at.is_(None))
    recipes = (await ctx.session.scalars(statement)).all()
    versions = await _latest_recipe_versions(ctx.session, [r.id for r in recipes])
    items = await _recipe_items(ctx.session, list(versions.values()))
    summaries = []
    for recipe in recipes:
        version = versions[recipe.id]
        totals = Nutrients.total(item.nutrients for item in items[version.id])
        summaries.append(
            RecipeSummary(
                id=recipe.id,
                name=recipe.name,
                serves=version.serves,
                per_portion=totals.scaled(1 / version.serves),
                archived=recipe.archived_at is not None,
            )
        )
    return RecipeList(recipes=summaries)


async def snapshot(
    session: AsyncSession, items: Sequence[tuple[uuid.UUID, float]], field: str = "items"
) -> list[SnapshotItem]:
    """Freeze the nutrients of eaten amounts at each food's current version (for the journal)."""
    food_ids = [uuid.UUID(str(food_id)) for food_id, _ in items]
    foods = await _foods_for_items(session, food_ids, field)
    versions = await _latest_food_versions(session, food_ids)
    return [
        SnapshotItem(
            food_id=food_id,
            food_version_id=versions[food_id].id,
            name=foods[food_id].name,
            kind=foods[food_id].kind,
            grams=grams,
            nutrients=_per_100(versions[food_id]).for_grams(grams, foods[food_id].kind),
        )
        for food_id, (_, grams) in zip(food_ids, items, strict=True)
    ]


async def recipe_items(
    session: AsyncSession, recipe_id: uuid.UUID, portions: float, field: str = "recipe_id"
) -> tuple[uuid.UUID, list[tuple[uuid.UUID, float]]]:
    """The current version id and its items scaled to `portions` (for the journal)."""
    recipe = await _recipe(session, uuid.UUID(str(recipe_id)), field)
    if recipe.archived_at is not None:
        raise RecipeArchived(recipe.id, field)
    version = (await _latest_recipe_versions(session, [recipe.id]))[recipe.id]
    factor = portions / version.serves
    return version.id, [
        (uuid.UUID(item["food_id"]), round(item["grams"] * factor, 2)) for item in version.items
    ]
