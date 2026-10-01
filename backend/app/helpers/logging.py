"""Logging: one JSON object per line in production, plain text for local work."""

import json
import logging
import sys

from app.helpers.time import utcnow


class JsonFormatter(logging.Formatter):
    """Formats a record as JSON; `record.context` (a dict) is carried along if present."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": utcnow().isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        context = getattr(record, "context", None)
        if context:
            entry["context"] = context
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def configure_logging(level: str, as_json: bool) -> None:
    """Route every logger to stdout at the given level."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter()
        if as_json
        else logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())


def get_logger(name: str) -> logging.Logger:
    """A logger under the `daily2.` namespace."""
    return logging.getLogger(f"daily2.{name}")
