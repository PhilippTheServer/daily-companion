"""The database: declarative base, one lazily built engine, and a swappable session source."""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import datetime
from functools import lru_cache
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.helpers.config import get_settings

SessionProvider = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class Base(DeclarativeBase):
    """Base of every table."""

    type_annotation_map = {
        datetime: sa.DateTime(timezone=True),
        dict[str, Any]: JSONB,
        list[Any]: JSONB,
    }


class CreatedAtMixin:
    """A server-set creation timestamp."""

    created_at: Mapped[datetime] = mapped_column(server_default=sa.func.now())


@lru_cache
def _engine() -> AsyncEngine:
    return create_async_engine(
        get_settings().database_url,
        pool_pre_ping=True,
        connect_args={"options": "-c timezone=utc"},
    )


@lru_cache
def _sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(_engine(), expire_on_commit=False)


@asynccontextmanager
async def _default_session() -> AsyncIterator[AsyncSession]:
    async with _sessionmaker()() as session:
        yield session


_provider: SessionProvider = _default_session


def open_session() -> AbstractAsyncContextManager[AsyncSession]:
    """A session from the current provider; REST, MCP and background jobs all use this."""
    return _provider()


def override_session_provider(provider: SessionProvider | None) -> None:
    """Swap where sessions come from (tests); None restores the default."""
    global _provider
    _provider = provider or _default_session


async def dispose_engine() -> None:
    """Close the pool, if one was ever opened."""
    if _engine.cache_info().currsize:
        await _engine().dispose()
        _engine.cache_clear()
        _sessionmaker.cache_clear()


async def try_advisory_xact_lock(session: AsyncSession, key: int) -> bool:
    """Take a transaction-scoped advisory lock without waiting."""
    return bool(await session.scalar(sa.select(sa.func.pg_try_advisory_xact_lock(key))))


async def ping(session: AsyncSession) -> None:
    """Round-trip to the database."""
    await session.execute(sa.text("SELECT 1"))
