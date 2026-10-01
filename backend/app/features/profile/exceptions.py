"""Every error the profile feature raises."""

from app.helpers.errors import ValidationFailed


class GoalIncomplete(ValidationFailed):
    """A goal needs both a weight and a date."""

    def __init__(self) -> None:
        super().__init__("goal_weight_kg and goal_date must be set together", "goal_date")


class FieldRequired(ValidationFailed):
    """A required profile field was sent as null."""

    def __init__(self, field: str) -> None:
        super().__init__(f"{field} cannot be cleared", field)
