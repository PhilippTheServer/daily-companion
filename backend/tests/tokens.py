"""Throwaway RSA keys and Keycloak-shaped tokens; nothing here talks to a real Keycloak."""

import os
import time
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

OWNER_SUB = os.environ["OWNER_SUB"]
ISSUER = "http://keycloak.test/realms/daily2"
RESOURCE_URL = "http://testserver/mcp"

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)

_jwk: dict[str, Any] = RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True)
_jwk.update(kid="test-key", use="sig", alg="RS256")
JWKS: dict[str, Any] = {"keys": [_jwk]}


async def fetch_jwks() -> dict[str, Any]:
    """The fixed test key set."""
    return JWKS


def make_token(
    *, key: Any = KEY, kid: str | None = "test-key", omit: tuple[str, ...] = (), **claims: Any
) -> str:
    """A signed access token for the owner via daily2-app, with claims overridable."""
    now = int(time.time())
    body: dict[str, Any] = {
        "iss": ISSUER,
        "sub": OWNER_SUB,
        "azp": "daily2-app",
        "aud": ["account"],
        "typ": "Bearer",
        "scope": "openid profile",
        "exp": now + 300,
        "iat": now,
        **claims,
    }
    for name in omit:
        body.pop(name, None)
    return jwt.encode(body, key, algorithm="RS256", headers={"kid": kid} if kid else {})


def app_token(**claims: Any) -> str:
    """A token the REST API accepts."""
    return make_token(**claims)


def mcp_token(**claims: Any) -> str:
    """A token the MCP server accepts."""
    return make_token(azp="daily2-mcp", aud=[RESOURCE_URL], **claims)
