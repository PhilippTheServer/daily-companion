"""Every error the days feature raises."""

from app.helpers.errors import ValidationFailed


class InvalidCursor(ValidationFailed):
    """The pagination cursor cannot be decoded."""

    def __init__(self) -> None:
        super().__init__("invalid cursor", "cursor")
