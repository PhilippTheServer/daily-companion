"""Keycloak: access-token verification for REST and MCP, and client-credentials tokens."""

import asyncio
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Literal

import httpx
import jwt
from fastapi import Request
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier

from app.helpers.config import Settings, get_settings
from app.helpers.errors import Forbidden, Unauthorized, Upstream
from app.helpers.logging import get_logger
from app.helpers.time import utcnow

logger = get_logger("auth")

JwksFetcher = Callable[[], Awaitable[dict[str, Any]]]
Source = Literal["app", "claude", "system"]


class JwksUnavailable(Exception):
    """The realm's signing keys could not be fetched and no usable cached copy exists."""


class TokenValidator:
    """Verifies RS256 access tokens from one realm, caching its JWKS."""

    def __init__(
        self,
        issuer: str,
        fetch_jwks: JwksFetcher,
        ttl_seconds: float = 300,
        cooldown_seconds: float = 30,
        max_stale_seconds: float = 86400,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._issuer = issuer
        self._fetch = fetch_jwks
        self._ttl = ttl_seconds
        self._cooldown = cooldown_seconds
        self._max_stale = max_stale_seconds
        self._clock = clock
        self._jwks: dict[str, Any] | None = None
        self._fetched_at = -math.inf
        self._failed_at = -math.inf
        self._lock: asyncio.Lock | None = None

    def _cached(self, force: bool, now: float) -> dict[str, Any] | None:
        if self._jwks is None:
            return None
        age = now - self._fetched_at
        if age < (self._cooldown if force else self._ttl):
            return self._jwks
        if now - self._failed_at < self._cooldown and age <= self._max_stale:
            return self._jwks
        return None

    async def _keys(self, force: bool) -> dict[str, Any]:
        cached = self._cached(force, self._clock())
        if cached is not None:
            return cached
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            now = self._clock()
            cached = self._cached(force, now)
            if cached is not None:
                return cached
            if self._jwks is None and now - self._failed_at < self._cooldown:
                raise JwksUnavailable("recent JWKS fetch failed")
            try:
                self._jwks = await self._fetch()
            except JwksUnavailable:
                self._failed_at = now
                if self._jwks is None or now - self._fetched_at > self._max_stale:
                    raise
                logger.warning("JWKS refresh failed; using the cached keys")
            else:
                self._fetched_at = self._clock()
            return self._jwks

    @staticmethod
    def _find(jwks: dict[str, Any], kid: str | None) -> jwt.PyJWK | None:
        for entry in jwks.get("keys") or []:
            if not isinstance(entry, dict) or entry.get("kid") != kid:
                continue
            if entry.get("kty") != "RSA" or entry.get("use") not in (None, "sig"):
                continue
            if entry.get("alg") not in (None, "RS256"):
                continue
            try:
                return jwt.PyJWK.from_dict(entry)
            except jwt.PyJWKError, ValueError, TypeError:
                return None
        return None

    async def decode(self, token: str) -> dict[str, Any]:
        """Verified claims; raises jwt.PyJWTError or JwksUnavailable."""
        kid = jwt.get_unverified_header(token).get("kid")
        key = self._find(await self._keys(force=False), kid)
        if key is None:
            key = self._find(await self._keys(force=True), kid)
        if key is None:
            raise jwt.InvalidKeyError("unknown signing key")
        return jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            issuer=self._issuer,
            leeway=30,
            options={"verify_aud": False, "require": ["exp", "iss", "sub"]},
        )


def http_jwks_fetcher(url: str) -> JwksFetcher:
    """A fetcher that GETs the JWKS document over HTTP."""

    async def fetch() -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(url)
                response.raise_for_status()
                body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise JwksUnavailable(url) from exc
        if not isinstance(body, dict) or not isinstance(body.get("keys"), list):
            raise JwksUnavailable(url)
        return body

    return fetch


_validator_override: TokenValidator | None = None


@lru_cache
def _default_validator() -> TokenValidator:
    settings = get_settings()
    return TokenValidator(settings.keycloak_issuer, http_jwks_fetcher(settings.keycloak_jwks_uri))


def get_token_validator() -> TokenValidator:
    """The validator in use: the override if set, else the process-wide one."""
    return _validator_override or _default_validator()


def override_token_validator(validator: TokenValidator | None) -> None:
    """Swap the validator (tests); None restores the default."""
    global _validator_override
    _validator_override = validator


@dataclass(frozen=True)
class Principal:
    """Who is calling: the owner through the app or Claude, or the system itself."""

    sub: str
    client_id: str
    source: Source


SYSTEM = Principal(sub="system", client_id="system", source="system")


async def verify_access_token(
    token: str, settings: Settings, validator: TokenValidator
) -> dict[str, Any]:
    """Claims of a valid owner access token; anything else raises an AppError."""
    try:
        claims = await validator.decode(token)
    except JwksUnavailable as exc:
        raise Upstream("identity provider unreachable") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("invalid token") from exc
    if claims.get("typ") != "Bearer":
        raise Unauthorized("invalid token")
    if not settings.owner_sub or claims.get("sub") != settings.owner_sub:
        raise Forbidden("caller is not the owner")
    return claims


async def rest_principal(request: Request) -> Principal:
    """FastAPI dependency: the owner calling through the daily2-app client."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized("missing bearer token")
    settings = get_settings()
    claims = await verify_access_token(token, settings, get_token_validator())
    if claims.get("azp") != settings.app_client_id:
        raise Forbidden("token was not issued for this application")
    return Principal(sub=claims["sub"], client_id=settings.app_client_id, source="app")


class McpTokenVerifier(TokenVerifier):
    """Lets the MCP SDK accept only owner tokens of daily2-mcp minted for this resource."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def verify_token(self, token: str) -> AccessToken | None:
        """The access token if it is valid for this resource; None (never an error) otherwise."""
        try:
            claims = await verify_access_token(token, self._settings, get_token_validator())
        except Unauthorized, Forbidden, Upstream:
            return None
        audience = claims.get("aud", [])
        audience = [audience] if isinstance(audience, str) else audience
        if not isinstance(audience, list) or not all(isinstance(a, str) for a in audience):
            return None
        scope = claims.get("scope", "")
        if not isinstance(scope, str):
            return None
        if self._settings.mcp_resource_url not in audience:
            return None
        if claims.get("azp") != self._settings.mcp_client_id:
            return None
        return AccessToken(
            token=token,
            client_id=claims["azp"],
            scopes=scope.split(),
            expires_at=claims.get("exp"),
            resource=self._settings.mcp_resource_url,
            subject=claims["sub"],
            claims={"iss": claims["iss"]},
        )


def mcp_principal() -> Principal:
    """The caller of the current MCP request, as verified by McpTokenVerifier."""
    access = get_access_token()
    if access is None or access.subject is None:
        raise Unauthorized("missing token")
    return Principal(sub=access.subject, client_id=access.client_id, source="claude")


class ClientCredentials:
    """A service account's access token, cached until 30 seconds before it expires."""

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        http: httpx.AsyncClient,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http
        self._clock = clock
        self._token: str | None = None
        self._expires_at: datetime | None = None

    async def token(self) -> str:
        """A valid bearer token; raises Upstream when Keycloak does not issue one."""
        now = self._clock()
        if self._token is not None and self._expires_at is not None and now < self._expires_at:
            return self._token
        try:
            response = await self._http.post(
                self._token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                },
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise Upstream("identity provider did not issue a token") from exc
        if not isinstance(body, dict):
            raise Upstream("identity provider returned an invalid token response")
        token, expires_in = body.get("access_token"), body.get("expires_in")
        if (
            not isinstance(token, str)
            or isinstance(expires_in, bool)
            or not isinstance(expires_in, int | float)
        ):
            raise Upstream("identity provider returned an invalid token response")
        self._token = token
        self._expires_at = now + timedelta(seconds=max(0.0, expires_in - 30))
        return token

    async def aclose(self) -> None:
        """Close the HTTP client."""
        await self._http.aclose()
