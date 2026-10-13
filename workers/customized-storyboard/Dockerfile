FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app/customized-storyboard
COPY shared/ai-runtime /app/shared/ai-runtime
COPY shared/customized-production-runtime /app/shared/customized-production-runtime
COPY customized-storyboard/pyproject.toml customized-storyboard/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY customized-storyboard/src ./src
RUN uv sync --frozen --no-dev && useradd --create-home --uid 10001 storyboard
USER storyboard
CMD ["/app/customized-storyboard/.venv/bin/customized-storyboard-worker"]
