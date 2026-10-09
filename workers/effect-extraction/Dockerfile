FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    DOCLING_DEVICE=cpu \
    OMP_NUM_THREADS=4 \
    DOCLING_ARTIFACTS_PATH=/models \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
    && apt-get install --no-install-recommends -y libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/effect-extraction
COPY shared/extraction-runtime /app/shared/extraction-runtime
COPY effect-extraction/pyproject.toml effect-extraction/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
RUN /app/effect-extraction/.venv/bin/playwright install --with-deps chromium \
    && useradd --create-home --uid 10001 extraction \
    && chmod -R a+rX /ms-playwright
COPY effect-extraction/src ./src
RUN uv sync --frozen --no-dev

USER extraction

CMD ["/app/effect-extraction/.venv/bin/effect-extraction-worker"]
