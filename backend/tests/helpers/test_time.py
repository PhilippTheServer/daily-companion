from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from app.helpers.time import day_bounds, local_day, to_local, to_utc


def test_to_utc_converts_an_offset_timestamp():
    moment = datetime(2026, 9, 30, 8, 0, tzinfo=timezone(timedelta(hours=2)))
    assert to_utc(moment) == datetime(2026, 9, 30, 6, 0, tzinfo=UTC)


def test_to_utc_rejects_a_naive_timestamp():
    with pytest.raises(ValueError, match="UTC offset"):
        to_utc(datetime(2026, 9, 30, 8, 0))


def test_local_day_uses_the_timezone():
    late_utc = datetime(2026, 9, 30, 22, 30, tzinfo=UTC)
    assert local_day(late_utc, "Europe/Berlin") == date(2026, 10, 1)
    assert local_day(late_utc, "UTC") == date(2026, 9, 30)


def test_day_bounds_cover_a_dst_change():
    start, end = day_bounds(date(2026, 10, 25), "Europe/Berlin")
    assert start == datetime(2026, 10, 24, 22, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 25, 23, 0, tzinfo=UTC)
    assert end - start == timedelta(hours=25)


def test_to_local_keeps_the_instant():
    moment = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
    local = to_local(moment, "Europe/Berlin")
    assert local.hour == 14
    assert local == moment
