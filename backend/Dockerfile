FROM python:3.14-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH="/app/.venv/bin:$PATH"
WORKDIR /app
RUN useradd --uid 10001 --no-create-home daily2
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY alembic.ini docker-entrypoint.sh ./
COPY alembic ./alembic
COPY app ./app
RUN uv sync --frozen --no-dev && chmod +x docker-entrypoint.sh
USER daily2
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
ENTRYPOINT ["./docker-entrypoint.sh"]
