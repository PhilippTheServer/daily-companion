"""Every error the integrations feature raises."""

from app.helpers.errors import NotFound


class UnknownSource(NotFound):
    """No configured source has that name."""

    def __init__(self, source: str) -> None:
        super().__init__(f"no configured source named {source}", "source")
