FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app/customized-production
COPY shared/ai-runtime /app/shared/ai-runtime
COPY shared/customized-production-runtime /app/shared/customized-production-runtime
COPY customized-production/pyproject.toml customized-production/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY customized-production/src ./src
RUN uv sync --frozen --no-dev && useradd --create-home --uid 10001 worker
USER worker
CMD ["/app/customized-production/.venv/bin/customized-production-worker"]
