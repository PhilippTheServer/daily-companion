"""Idempotent commands: a repeated key returns the stored response instead of re-running."""

from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from app.helpers.database import Base, CreatedAtMixin
from app.helpers.errors import Conflict


class CommandLog(Base, CreatedAtMixin):
    """One remembered command response per idempotency key."""

    __tablename__ = "command_log"

    idempotency_key: Mapped[str] = mapped_column(sa.String(200), primary_key=True)
    command: Mapped[str] = mapped_column(sa.String(100))
    response: Mapped[dict[str, Any]]


async def replay(session: AsyncSession, key: str, command: str) -> dict[str, Any] | None:
    """The stored response for a key, None if unused; a key of another command is a conflict."""
    row = await session.get(CommandLog, key)
    if row is None:
        return None
    if row.command != command:
        raise Conflict(f"idempotency key was already used for {row.command}", "idempotency_key")
    return row.response


def remember(session: AsyncSession, key: str, command: str, response: dict[str, Any]) -> None:
    """Store a response; it is committed together with the command's own writes."""
    session.add(CommandLog(idempotency_key=key, command=command, response=response))
