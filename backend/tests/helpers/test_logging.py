import json
import logging

from app.helpers.logging import JsonFormatter, get_logger


def test_json_formatter_emits_one_json_object():
    record = logging.LogRecord("daily2.test", logging.INFO, __file__, 1, "hello %s", ("you",), None)
    record.context = {"source": "gym-bro"}
    entry = json.loads(JsonFormatter().format(record))
    assert entry["level"] == "INFO"
    assert entry["logger"] == "daily2.test"
    assert entry["message"] == "hello you"
    assert entry["context"] == {"source": "gym-bro"}
    assert "ts" in entry


def test_get_logger_namespaces_under_daily2():
    assert get_logger("journal").name == "daily2.journal"
