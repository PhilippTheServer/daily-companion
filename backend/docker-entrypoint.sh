#!/bin/sh
set -e
alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers "${WORKERS:-1}" --proxy-headers --forwarded-allow-ips='*'
