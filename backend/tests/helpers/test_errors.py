import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy.exc import IntegrityError

from app.helpers.errors import (
    AppError,
    Conflict,
    ErrorBody,
    Internal,
    NotFound,
    ValidationFailed,
    from_validation_errors,
    to_app_error,
)
from app.helpers.responses import error_responses


class _Model(BaseModel):
    grams: int


def test_app_error_body_carries_code_message_and_field():
    error = NotFound("food not found", "food_id")
    assert (error.status, error.code) == (404, "not_found")
    assert error.body() == ErrorBody(code="not_found", message="food not found", field="food_id")


def test_validation_error_becomes_validation_failed_with_a_dotted_field():
    with pytest.raises(ValidationError) as caught:
        _Model.model_validate({"grams": "many"})
    error = to_app_error(caught.value)
    assert isinstance(error, ValidationFailed)
    assert error.field == "grams"


def test_prefix_is_prepended_to_the_field():
    error = from_validation_errors([{"loc": ("body", "grams"), "msg": "bad"}], prefix="events.0")
    assert error.field == "events.0.grams"
    assert error.message == "bad"


def test_field_preserves_nested_transport_marker_names():
    error = from_validation_errors([{"loc": ("body", "item", "path"), "msg": "bad"}])
    assert error.field == "item.path"


def test_field_preserves_single_element_location_named_path():
    error = from_validation_errors([{"loc": ("path",), "msg": "bad"}])
    assert error.field == "path"


def test_integrity_error_becomes_a_generic_conflict():
    error = to_app_error(IntegrityError("stmt", {}, Exception("dup")))
    assert isinstance(error, Conflict)
    assert error.message == "conflicting data"


def test_unknown_exception_becomes_internal_without_leaking_its_text():
    error = to_app_error(RuntimeError("secret detail"))
    assert isinstance(error, Internal)
    assert error.message == "internal error"


def test_app_error_passes_through():
    original = Conflict("taken")
    assert to_app_error(original) is original


def test_error_responses_group_codes_by_status():
    class StaleHead(Conflict):
        code = "stale_head"

    responses = error_responses([NotFound, Conflict, StaleHead])
    assert responses[404]["model"] is ErrorBody
    assert responses[409]["description"] == "conflict, stale_head"


def test_base_class_is_internal():
    assert (AppError.status, AppError.code) == (500, "internal")
