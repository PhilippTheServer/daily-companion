"""Shared fixtures. Tests that need Postgres are marked requires_db and skip without
TEST_DATABASE_URL (see README); everything else runs anywhere."""

import os

os.environ.update(
    {
        "OWNER_SUB": "11111111-1111-1111-1111-111111111111",
        "KEYCLOAK_URL": "http://keycloak.test",
        "KEYCLOAK_PUBLIC_URL": "http://keycloak.test",
        "KEYCLOAK_REALM": "daily2",
        "MCP_RESOURCE_URL": "http://testserver/mcp",
        "MCP_ALLOWED_HOSTS": '["testserver"]',
        "DEFAULT_TIMEZONE": "Europe/Berlin",
        "LOG_JSON": "false",
        "GYM_BRO_URL": "",
        "GYM_BRO_CLIENT_SECRET": "",
    }
)
if os.getenv("TEST_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]

from collections.abc import AsyncIterator, Iterator  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

import app.main  # noqa: E402, F401
from app.helpers.database import Base, override_session_provider  # noqa: E402

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")

requires_db = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL is not set")


@pytest.fixture(scope="session")
def schema() -> Iterator[None]:
    """Create every table once per run over a synchronous connection, drop them afterwards."""
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not set")
    engine = create_engine(TEST_DATABASE_URL)
    if not (engine.url.database or "").endswith("_test"):
        engine.dispose()
        pytest.exit("refusing to drop tables: TEST_DATABASE_URL must name a *_test database")
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest_asyncio.fixture
async def session(schema) -> AsyncIterator[AsyncSession]:
    """A session inside a transaction that is rolled back after the test; the code's own
    commit() only releases a savepoint."""
    engine = create_async_engine(TEST_DATABASE_URL, connect_args={"options": "-c timezone=utc"})
    connection = await engine.connect()
    transaction = await connection.begin()
    factory = async_sessionmaker(
        bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )
    async with factory() as db_session:
        yield db_session
    await transaction.rollback()
    await connection.close()
    await engine.dispose()


@pytest.fixture
def db(session: AsyncSession) -> Iterator[AsyncSession]:
    """Route open_session() to the test session, so REST and MCP calls share the rollback."""

    @asynccontextmanager
    async def provider() -> AsyncIterator[AsyncSession]:
        yield session

    override_session_provider(provider)
    yield session
    override_session_provider(None)


from app.helpers.auth import TokenValidator, override_token_validator  # noqa: E402
from tests.tokens import ISSUER, fetch_jwks  # noqa: E402


@pytest.fixture(autouse=True)
def validator() -> Iterator[TokenValidator]:
    """Verify tokens against the in-memory test keys instead of a real Keycloak."""
    token_validator = TokenValidator(ISSUER, fetch_jwks)
    override_token_validator(token_validator)
    yield token_validator
    override_token_validator(None)


import httpx  # noqa: E402

from app.main import create_app  # noqa: E402
from tests.clients import app_client  # noqa: E402
from tests.tokens import app_token  # noqa: E402


@pytest_asyncio.fixture
async def rest(db) -> AsyncIterator[httpx.AsyncClient]:
    """REST client on the full app, authenticated as the owner via daily2-app."""
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {app_token()}"},
    ) as client:
        yield client


@pytest.fixture
def mcp(db):
    """Factory for an MCP-capable client; enter it inside the test (`async with mcp() as c`),
    because the MCP session manager must start and stop in the same task."""
    return lambda: app_client(create_app())
