FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_DEV=1 \
    DOCLING_DEVICE=cpu \
    OMP_NUM_THREADS=4 \
    DOCLING_ARTIFACTS_PATH=/root/.cache/docling/models

RUN apt-get update \
    && apt-get install --no-install-recommends -y libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

CMD ["/app/.venv/bin/effect-extraction-worker"]
