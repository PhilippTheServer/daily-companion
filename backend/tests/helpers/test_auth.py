import asyncio
import time
from datetime import UTC, datetime, timedelta

import httpx
import jwt
import pytest
from jwt.algorithms import RSAAlgorithm
from starlette.requests import Request

from app.helpers.auth import (
    ClientCredentials,
    JwksUnavailable,
    McpTokenVerifier,
    TokenValidator,
    http_jwks_fetcher,
    rest_principal,
    verify_access_token,
)
from app.helpers.config import get_settings
from app.helpers.errors import Forbidden, Unauthorized, Upstream
from tests.tokens import (
    ISSUER,
    JWKS,
    OTHER_KEY,
    OWNER_SUB,
    RESOURCE_URL,
    app_token,
    fetch_jwks,
    make_token,
    mcp_token,
)


def _request(authorization: str | None) -> Request:
    headers = [(b"authorization", authorization.encode())] if authorization else []
    return Request({"type": "http", "headers": headers})


async def test_decode_accepts_a_valid_token():
    claims = await TokenValidator(ISSUER, fetch_jwks).decode(app_token())
    assert claims["sub"] == OWNER_SUB


async def test_decode_rejects_a_wrong_issuer_and_a_foreign_key():
    validator = TokenValidator(ISSUER, fetch_jwks)
    with pytest.raises(jwt.InvalidIssuerError):
        await validator.decode(make_token(iss="http://evil/realms/daily2"))
    with pytest.raises(jwt.InvalidSignatureError):
        await validator.decode(make_token(key=OTHER_KEY))


async def test_unknown_kid_never_fetches_more_than_once_per_cooldown():
    calls = 0

    async def counting_fetch():
        nonlocal calls
        calls += 1
        return JWKS

    validator = TokenValidator(ISSUER, counting_fetch)
    for _ in range(2):
        with pytest.raises(jwt.InvalidKeyError):
            await validator.decode(make_token(kid="unknown"))
    assert calls == 1


async def test_key_rotation_forces_a_refresh_after_the_cooldown():
    now = [0.0]
    rotated = dict(RSAAlgorithm.to_jwk(OTHER_KEY.public_key(), as_dict=True))
    rotated.update(kid="rotated", use="sig", alg="RS256")
    served = [JWKS]

    async def fetch():
        return served[0]

    validator = TokenValidator(ISSUER, fetch, clock=lambda: now[0])
    await validator.decode(app_token())
    served[0] = {"keys": [rotated]}
    now[0] = 31
    claims = await validator.decode(make_token(key=OTHER_KEY, kid="rotated"))
    assert claims["sub"] == OWNER_SUB


async def test_a_failing_refresh_is_attempted_once_per_cooldown():
    now = [0.0]
    attempts = 0

    async def flaky_fetch():
        nonlocal attempts
        attempts += 1
        if attempts > 1:
            raise JwksUnavailable("down")
        return JWKS

    validator = TokenValidator(ISSUER, flaky_fetch, ttl_seconds=10, clock=lambda: now[0])
    await validator.decode(app_token())
    now[0] = 50
    for _ in range(5):
        assert (await validator.decode(app_token()))["sub"] == OWNER_SUB
    assert attempts == 2
    now[0] = 81
    await validator.decode(app_token())
    assert attempts == 3


async def test_a_cold_outage_raises_immediately_within_the_cooldown():
    attempts = 0

    async def down():
        nonlocal attempts
        attempts += 1
        raise JwksUnavailable("down")

    validator = TokenValidator(ISSUER, down, clock=lambda: 0.0)
    for _ in range(3):
        with pytest.raises(JwksUnavailable):
            await validator.decode(app_token())
    assert attempts == 1


async def test_concurrent_waiters_share_one_fetch():
    calls = 0

    async def slow_fetch():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return JWKS

    validator = TokenValidator(ISSUER, slow_fetch)
    await asyncio.gather(*(validator.decode(app_token()) for _ in range(5)))
    assert calls == 1


async def test_cached_keys_survive_a_failing_refresh_until_they_are_too_stale():
    now = [0.0]
    fail = [False]

    async def flaky_fetch():
        if fail[0]:
            raise JwksUnavailable("down")
        return JWKS

    validator = TokenValidator(
        ISSUER, flaky_fetch, ttl_seconds=10, max_stale_seconds=100, clock=lambda: now[0]
    )
    await validator.decode(app_token())
    fail[0] = True
    now[0] = 50
    assert (await validator.decode(app_token()))["sub"] == OWNER_SUB
    now[0] = 500
    with pytest.raises(JwksUnavailable):
        await validator.decode(app_token())


async def test_verify_access_token_maps_every_failure():
    settings = get_settings()
    good = TokenValidator(ISSUER, fetch_jwks)
    assert (await verify_access_token(app_token(), settings, good))["sub"] == OWNER_SUB
    with pytest.raises(Unauthorized):
        await verify_access_token("not-a-jwt", settings, good)
    with pytest.raises(Unauthorized):
        await verify_access_token(make_token(typ="ID"), settings, good)
    with pytest.raises(Forbidden):
        await verify_access_token(make_token(sub="someone-else"), settings, good)

    async def down():
        raise JwksUnavailable("down")

    with pytest.raises(Upstream):
        await verify_access_token(app_token(), settings, TokenValidator(ISSUER, down))


async def test_rest_principal_requires_a_bearer_token_for_the_app_client():
    principal = await rest_principal(_request(f"Bearer {app_token()}"))
    assert (principal.sub, principal.source) == (OWNER_SUB, "app")
    with pytest.raises(Unauthorized):
        await rest_principal(_request(None))
    with pytest.raises(Unauthorized):
        await rest_principal(_request("Basic abc"))
    with pytest.raises(Forbidden):
        await rest_principal(_request(f"Bearer {mcp_token()}"))


async def test_mcp_verifier_requires_the_resource_audience_and_the_mcp_client():
    verifier = McpTokenVerifier(get_settings())
    access = await verifier.verify_token(mcp_token())
    assert access is not None
    assert (access.subject, access.client_id, access.resource) == (
        OWNER_SUB,
        "daily2-mcp",
        RESOURCE_URL,
    )
    assert "openid" in access.scopes
    assert await verifier.verify_token(make_token(azp="daily2-mcp")) is None
    assert await verifier.verify_token(app_token(aud=[RESOURCE_URL])) is None
    assert await verifier.verify_token(mcp_token(sub="someone-else")) is None


async def test_client_credentials_caches_until_shortly_before_expiry():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"access_token": f"t{calls}", "expires_in": 300})

    now = [datetime(2026, 9, 30, tzinfo=UTC)]
    provider = ClientCredentials(
        "http://kc/token",
        "svc",
        "secret",
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        clock=lambda: now[0],
    )
    assert await provider.token() == "t1"
    assert await provider.token() == "t1"
    now[0] += timedelta(seconds=280)
    assert await provider.token() == "t2"
    await provider.aclose()


async def test_client_credentials_failures_are_upstream_errors():
    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": True})

    provider = ClientCredentials(
        "http://kc/token", "svc", "s", httpx.AsyncClient(transport=httpx.MockTransport(broken))
    )
    with pytest.raises(Upstream):
        await provider.token()

    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    provider = ClientCredentials(
        "http://kc/token", "svc", "s", httpx.AsyncClient(transport=httpx.MockTransport(down))
    )
    with pytest.raises(Upstream):
        await provider.token()


async def test_mcp_verifier_rejects_malformed_claims_without_raising():
    verifier = McpTokenVerifier(get_settings())
    assert await verifier.verify_token(make_token(azp="daily2-mcp", aud=5)) is None
    assert await verifier.verify_token(make_token(azp="daily2-mcp", aud=[RESOURCE_URL, 5])) is None
    assert await verifier.verify_token(mcp_token(scope=5)) is None
    assert await verifier.verify_token(make_token(azp="daily2-mcp", aud=RESOURCE_URL)) is not None


async def test_client_credentials_rejects_malformed_bodies():
    for body in ([1, 2], "text", {"access_token": "t", "expires_in": True}):

        def handler(request: httpx.Request, body=body) -> httpx.Response:
            return httpx.Response(200, json=body)

        provider = ClientCredentials(
            "http://kc/token", "svc", "s", httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        with pytest.raises(Upstream):
            await provider.token()


async def test_expired_and_expiry_less_tokens_are_rejected():
    settings = get_settings()
    validator = TokenValidator(ISSUER, fetch_jwks)
    expired = make_token(exp=int(time.time()) - 1000)
    with pytest.raises(jwt.ExpiredSignatureError):
        await validator.decode(expired)
    with pytest.raises(Unauthorized):
        await verify_access_token(expired, settings, validator)
    with pytest.raises(Unauthorized):
        await verify_access_token(make_token(omit=("exp",)), settings, validator)


def _claims() -> dict:
    now = int(time.time())
    return {"iss": ISSUER, "sub": OWNER_SUB, "typ": "Bearer", "exp": now + 300, "iat": now}


async def test_tokens_with_a_forged_algorithm_are_rejected():
    settings = get_settings()
    validator = TokenValidator(ISSUER, fetch_jwks)
    hs256 = jwt.encode(_claims(), "x" * 64, algorithm="HS256", headers={"kid": "test-key"})
    unsigned = jwt.encode(_claims(), None, algorithm="none", headers={"kid": "test-key"})
    for forged in (hs256, unsigned):
        with pytest.raises(Unauthorized):
            await verify_access_token(forged, settings, validator)


async def test_encryption_keys_in_the_jwks_are_ignored():
    async def fetch():
        return {"keys": [{**JWKS["keys"][0], "use": "enc"}]}

    with pytest.raises(jwt.InvalidKeyError):
        await TokenValidator(ISSUER, fetch).decode(app_token())


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"<html>"),
        httpx.Response(500),
        httpx.Response(200, json={"nope": []}),
        httpx.Response(200, json=[1]),
    ],
)
async def test_http_jwks_fetcher_maps_bad_responses_to_unavailable(monkeypatch, response):
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(lambda request: response), **kw),
    )
    with pytest.raises(JwksUnavailable):
        await http_jwks_fetcher("http://kc/certs")()


async def test_http_jwks_fetcher_returns_a_valid_document(monkeypatch):
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=JWKS)), **kw
        ),
    )
    assert await http_jwks_fetcher("http://kc/certs")() == JWKS
