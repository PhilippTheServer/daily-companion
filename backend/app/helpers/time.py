"""Time helpers: everything is stored in UTC, and days are local to a timezone."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def utcnow() -> datetime:
    """The current instant in UTC."""
    return datetime.now(UTC)


def to_utc(value: datetime) -> datetime:
    """Convert an offset-aware timestamp to UTC; a naive one is rejected."""
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp needs a UTC offset")
    return value.astimezone(UTC)


def to_local(moment: datetime, timezone: str) -> datetime:
    """The same instant expressed in the given IANA timezone."""
    return to_utc(moment).astimezone(ZoneInfo(timezone))


def local_day(moment: datetime, timezone: str) -> date:
    """The calendar day of an instant in the given timezone."""
    return to_local(moment, timezone).date()


def day_bounds(day: date, timezone: str) -> tuple[datetime, datetime]:
    """The UTC start (inclusive) and end (exclusive) of a local day."""
    zone = ZoneInfo(timezone)
    start = datetime.combine(day, time.min, zone)
    end = datetime.combine(day + timedelta(days=1), time.min, zone)
    return start.astimezone(UTC), end.astimezone(UTC)
