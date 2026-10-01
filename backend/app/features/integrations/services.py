"""gym-bro's export API, authenticated as daily's Keycloak service account."""

from datetime import datetime
from typing import Any

import httpx

from app.helpers.auth import ClientCredentials
from app.helpers.config import get_settings
from app.helpers.errors import Upstream
from app.helpers.services import services

_PAGE = 100
_EXPORT_PATH = "/api/v1/export/workouts"


class GymBroClient:
    """Pages through completed workout sessions."""

    def __init__(self, http: httpx.AsyncClient, base_url: str, tokens: ClientCredentials) -> None:
        self._http = http
        self._base_url = base_url.rstrip("/")
        self._tokens = tokens

    async def _page(
        self, user_id: str, completed_after: datetime, offset: int
    ) -> list[dict[str, Any]]:
        token = await self._tokens.token()
        try:
            response = await self._http.get(
                f"{self._base_url}{_EXPORT_PATH}",
                params={
                    "user_id": user_id,
                    "completed_after": completed_after.isoformat(),
                    "limit": _PAGE,
                    "offset": offset,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise Upstream("gym-bro did not answer") from exc
        if not isinstance(body, list):
            raise Upstream("gym-bro answered with an unexpected shape")
        return body

    async def completed_sessions(
        self, user_id: str, completed_after: datetime
    ) -> list[dict[str, Any]]:
        """Every session the user completed after the given instant, oldest first."""
        sessions: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = await self._page(user_id, completed_after, offset)
            sessions.extend(page)
            if len(page) < _PAGE:
                return sessions
            offset += _PAGE

    async def aclose(self) -> None:
        """Close the HTTP client (shared with the token provider)."""
        await self._http.aclose()


def _build() -> GymBroClient:
    settings = get_settings()
    http = httpx.AsyncClient(timeout=20)
    tokens = ClientCredentials(
        settings.keycloak_token_url,
        settings.gym_bro_client_id,
        settings.gym_bro_client_secret,
        http,
    )
    return GymBroClient(http, settings.gym_bro_url, tokens)


services.register("gym-bro", _build)


def gym_bro() -> GymBroClient:
    """The gym-bro client in use."""
    return services.get("gym-bro")
