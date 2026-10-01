"""The catalog feature's endpoints."""

from app.features.catalog import functions
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
    FoodImport,
    FoodOut,
    FoodSave,
    FoodSearch,
    FoodSearchOut,
    RecipeList,
    RecipeListQuery,
    RecipeOut,
    RecipeSave,
)
from app.helpers.endpoints import command, query
from app.helpers.models import ById, ByIdCommand

OPERATIONS = (
    command(
        "import_food",
        FoodImport,
        FoodOut,
        functions.import_food,
        "Add an Open Food Facts product to the catalog by barcode (from a find_food remote hit); "
        "returns the existing food if it is already there.",
        errors=(NotOnOpenFoodFacts, NoNutritionData),
    ),
    command(
        "save_food",
        FoodSave,
        FoodOut,
        functions.save_food,
        "Create a food by hand (without id; name and per_100 required) or change one "
        "(with id; only sent fields change). New nutrients add a version; "
        "past intakes keep theirs.",
        errors=(FoodNotFound, FoodArchived, MissingForCreate),
    ),
    command(
        "archive_food",
        ByIdCommand,
        FoodOut,
        functions.archive_food,
        "Hide a food from search and new use; history keeps it.",
        errors=(FoodNotFound,),
        destructive=True,
    ),
    command(
        "save_recipe",
        RecipeSave,
        RecipeOut,
        functions.save_recipe,
        "Create a recipe (without id) or add a new version (with id): items, serves and steps.",
        errors=(RecipeNotFound, RecipeArchived, FoodNotFound, FoodArchived),
    ),
    command(
        "archive_recipe",
        ByIdCommand,
        RecipeOut,
        functions.archive_recipe,
        "Hide a recipe from lists and new use; history keeps it.",
        errors=(RecipeNotFound,),
        destructive=True,
    ),
    query(
        "find_food",
        FoodSearch,
        FoodSearchOut,
        functions.find_food,
        "Search foods: local catalog first, then Open Food Facts hits to import with import_food.",
        view="catalog",
    ),
    query(
        "get_food",
        ById,
        FoodOut,
        functions.get_food,
        "One food with its current nutrients per 100 g/ml.",
        errors=(FoodNotFound,),
        view="food",
    ),
    query(
        "get_recipe",
        ById,
        RecipeOut,
        functions.get_recipe,
        "One recipe: items, steps, totals and per portion.",
        errors=(RecipeNotFound,),
        view="recipe",
    ),
    query(
        "list_recipes",
        RecipeListQuery,
        RecipeList,
        functions.list_recipes,
        "All recipes by name with per-portion nutrients.",
        view="recipes",
    ),
)
