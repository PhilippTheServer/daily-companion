from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.helpers.errors import ValidationFailed
from app.helpers.models import (
    CommandInput,
    Nutrients,
    StrictModel,
    UtcDatetime,
    decode_cursor,
    encode_cursor,
)


class _Stamped(StrictModel):
    at: UtcDatetime


def test_utc_datetime_normalises_and_requires_an_offset():
    assert _Stamped(at="2026-09-30T08:00:00+02:00").at == datetime(2026, 9, 30, 6, tzinfo=UTC)
    with pytest.raises(ValidationError):
        _Stamped(at="2026-09-30T08:00:00")


def test_strict_models_reject_unknown_fields():
    with pytest.raises(ValidationError):
        CommandInput(idempotency_key="k", surprise=1)


def test_nutrients_add_scale_and_total():
    a = Nutrients(kcal=100, protein_g=10)
    b = Nutrients(kcal=50.5, fat_g=2)
    assert (a + b).kcal == 150.5
    assert a.scaled(1.5).protein_g == 15
    assert Nutrients.total([a, b, a]).kcal == 250.5
    assert Nutrients.total([]) == Nutrients()


def test_cursor_round_trip_and_rejects_garbage():
    assert decode_cursor(encode_cursor({"before": "2026-09-30"})) == {"before": "2026-09-30"}
    with pytest.raises(ValidationFailed):
        decode_cursor("%%%not-base64")
    with pytest.raises(ValidationFailed):
        decode_cursor(encode_cursor([1, 2]))  # type: ignore[arg-type]
