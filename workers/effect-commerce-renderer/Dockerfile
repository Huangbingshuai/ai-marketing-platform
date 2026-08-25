FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project \
    && /app/.venv/bin/playwright install --with-deps chromium \
    && useradd --create-home --uid 10001 renderer \
    && chmod -R a+rX /ms-playwright /app

COPY src ./src
RUN uv sync --frozen --no-dev \
    && chmod -R a+rX /app

USER renderer
EXPOSE 8080

CMD ["/app/.venv/bin/effect-commerce-renderer"]
