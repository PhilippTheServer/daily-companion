"""Every error the catalog feature raises."""

import uuid

from app.helpers.errors import Conflict, NotFound, ValidationFailed


class FoodNotFound(NotFound):
    """No food has this id."""

    def __init__(self, food_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"food {food_id} does not exist", field)


class RecipeNotFound(NotFound):
    """No recipe has this id."""

    def __init__(self, recipe_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"recipe {recipe_id} does not exist", field)


class FoodArchived(Conflict):
    """The food is archived and cannot be used or edited."""

    def __init__(self, food_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"food {food_id} is archived", field)


class RecipeArchived(Conflict):
    """The recipe is archived and cannot be used or edited."""

    def __init__(self, recipe_id: uuid.UUID | str, field: str = "id") -> None:
        super().__init__(f"recipe {recipe_id} is archived", field)


class MissingForCreate(ValidationFailed):
    """A field needed to create a food was not sent."""

    def __init__(self, field: str) -> None:
        super().__init__(f"{field} is required to create a food", field)


class NotOnOpenFoodFacts(NotFound):
    """Open Food Facts does not know the barcode."""

    def __init__(self, barcode: str) -> None:
        super().__init__(f"Open Food Facts has no product {barcode}", "barcode")


class NoNutritionData(ValidationFailed):
    """The Open Food Facts product carries no usable nutrients."""

    def __init__(self, name: str) -> None:
        super().__init__(f"{name} has no usable nutrition data on Open Food Facts", "barcode")
