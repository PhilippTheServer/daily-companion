"""UI smoke check without a browser: the frontend container serves the app, its runtime
config and the backend through its proxy, and Keycloak accepts the app's PKCE login.

Run against `docker compose --profile ui up -d --build --wait`:
    uv run --project backend python e2e/ui_smoke.py

The compose `frontend` service overrides KEYCLOAK_URL (host in upper case), so the check
also proves the runtime config and the CSP come from the container environment. The login's
redirect path and scope are read from the served main bundle by regex; if a build changes how
they are emitted, that lookup fails loudly rather than testing stale values.
"""

import base64
import hashlib
import re
import secrets
import sys
from html import unescape
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

UI = "http://localhost:18101"
KEYCLOAK = "http://localhost:18180"
KEYCLOAK_CONFIGURED = "http://LOCALHOST:18180"
REALM = f"{KEYCLOAK}/realms/daily2/protocol/openid-connect"
CLIENT = "daily2-app"


def check(name: str, condition: bool, detail: Any = "") -> None:
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        print(f"     {detail}")
        sys.exit(1)


def pkce_login(client: httpx.Client, redirect: str, scope: str) -> dict[str, Any]:
    """The browser's login, step by step: authorize, submit the form, exchange the code.

    Keycloak marks its login cookies Secure; browsers send those to http://localhost, but
    httpx does not, so they are passed on by hand.
    """
    verifier = secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    state = secrets.token_urlsafe(16)
    query = {
        "client_id": CLIENT,
        "response_type": "code",
        "scope": scope,
        "redirect_uri": redirect,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    page = client.get(f"{REALM}/auth?{urlencode(query)}")
    check("keycloak shows the login form", page.status_code == 200, page.text[:300])
    action = re.search(r'action="([^"]+)"', page.text)
    check("the login form has an action", action is not None, page.text[:300])
    cookies = "; ".join(f"{name}={value}" for name, value in page.cookies.items())
    submitted = client.post(
        unescape(action.group(1)),
        data={"username": "dev", "password": "dev"},
        headers={"Cookie": cookies},
    )
    location = submitted.headers.get("location", "")
    check(
        "keycloak redirects to the app's callback",
        location.startswith(redirect),
        location,
    )
    params = parse_qs(urlparse(location).query)
    check("the callback carries our state", params.get("state") == [state], params)
    tokens = client.post(
        f"{REALM}/token",
        data={
            "client_id": CLIENT,
            "grant_type": "authorization_code",
            "code": params["code"][0],
            "redirect_uri": redirect,
            "code_verifier": verifier,
        },
        headers={"Origin": UI},
    )
    check("the code exchange succeeds", tokens.status_code == 200, tokens.text)
    check(
        "keycloak allows the app's origin (CORS)",
        tokens.headers.get("access-control-allow-origin") == UI,
        dict(tokens.headers),
    )
    return tokens.json()


def cache_control(ui: httpx.Client, path: str) -> str:
    return ui.get(path).headers.get("cache-control", "")


def main() -> None:
    ui = httpx.Client(base_url=UI, timeout=20)
    index = ui.get("/")
    check("index.html is served", index.status_code == 200 and "<app-root>" in index.text)
    check(
        "index.html has no inline script (the CSP forbids them)",
        re.search(r"<script(?![^>]*\bsrc=)[^>]*>", index.text) is None,
        index.text,
    )
    check("a deep link falls back to index.html", "<app-root>" in ui.get("/diary").text)
    check("the service worker manifest exists", ui.get("/ngsw.json").status_code == 200)
    check(
        "/healthz answers for container health checks",
        ui.get("/healthz").text == "ok\n",
    )
    config = ui.get("/assets/runtime-config.json")
    check(
        "assets/runtime-config.json comes from the container environment",
        config.json()
        == {
            "apiBase": "/api/v2",
            "keycloakUrl": KEYCLOAK_CONFIGURED,
            "realm": "daily2",
            "clientId": CLIENT,
        },
        config.text,
    )
    cache = config.headers.get("cache-control", "")
    check("assets/runtime-config.json is not cached", "no-cache" in cache, cache)
    for path in ("/", "/index.html", "/ngsw.json"):
        check(f"{path} is no-cache", "no-cache" in cache_control(ui, path), path)
    script = re.search(r'<script[^>]*\bsrc="([^"]+\.js)"', index.text)
    check("index.html loads a hashed script", script is not None, index.text)
    main_js = ui.get(f"/{script.group(1)}")
    long_cache = main_js.headers.get("cache-control", "")
    max_age = re.search(r"max-age=(\d+)", long_cache)
    check(
        "hashed scripts are cached long",
        max_age is not None and int(max_age.group(1)) >= 31536000,
        long_cache,
    )
    check(
        "X-Content-Type-Options is nosniff",
        index.headers.get("x-content-type-options") == "nosniff",
        dict(index.headers),
    )
    csp = index.headers.get("content-security-policy", "")
    check(
        "the CSP allows exactly the configured Keycloak origin",
        f"connect-src 'self' {KEYCLOAK_CONFIGURED};" in csp,
        csp,
    )
    check("the CSP restricts form targets", "form-action 'self'" in csp, csp)
    mcp_get = ui.get("/mcp")
    mcp_post = ui.post("/mcp", json={})
    check(
        "/mcp is not proxied to the backend",
        mcp_get.status_code != 401
        and mcp_get.headers.get("content-type", "").startswith("text/html")
        and mcp_post.status_code == 405,
        f"GET {mcp_get.status_code} {mcp_get.headers.get('content-type')}, "
        f"POST {mcp_post.status_code}",
    )
    redirect_path = re.search(
        r"callbackUrl\(\)\{return[`'\"]\$\{window\.location\.origin\}(/[^`'\"]*)[`'\"]",
        main_js.text,
    )
    scope = re.search(r"response_type:[`'\"]code[`'\"],scope:[`'\"]([^`'\"]+)[`'\"]", main_js.text)
    check("the app's callback path is found in the bundle", redirect_path is not None)
    check("the app's login scope is found in the bundle", scope is not None)
    check(
        "/health is proxied to the backend",
        ui.get("/health").json().get("status") == "ok",
    )
    anonymous = ui.get("/api/v2/views/today")
    check(
        "/api is proxied and asks for a token",
        anonymous.status_code == 401 and anonymous.json().get("code") == "unauthorized",
        anonymous.text,
    )

    with httpx.Client(timeout=20, follow_redirects=False) as browser:
        tokens = pkce_login(browser, f"{UI}{redirect_path.group(1)}", scope.group(1))
    authed = {"Authorization": f"Bearer {tokens['access_token']}"}
    today = ui.get("/api/v2/views/today", headers=authed)
    check(
        "the PKCE token opens Today through the proxy",
        today.status_code == 200,
        today.text,
    )
    check("Today has four gauges", len(today.json()["day"]["summary"]["gauges"]) == 4)
    refreshed = httpx.post(
        f"{REALM}/token",
        data={
            "client_id": CLIENT,
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=20,
    )
    check("the refresh token works", refreshed.status_code == 200, refreshed.text)
    logout = httpx.get(
        f"{REALM}/logout",
        params={
            "client_id": CLIENT,
            "post_logout_redirect_uri": f"{UI}/",
            "id_token_hint": tokens["id_token"],
        },
        timeout=20,
    )
    check(
        "keycloak logs out back to the app",
        logout.status_code == 302 and logout.headers.get("location") == f"{UI}/",
        f"{logout.status_code} {logout.headers.get('location')} {logout.text[:200]}",
    )
    print("All UI checks passed.")


if __name__ == "__main__":
    main()
