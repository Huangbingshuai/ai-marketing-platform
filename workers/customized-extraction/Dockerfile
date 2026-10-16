FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_LINK_MODE=copy DOCLING_DEVICE=cpu DOCLING_ARTIFACTS_PATH=/models OMP_NUM_THREADS=4
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install --no-install-recommends -y libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/customized-extraction
COPY shared/ai-runtime /app/shared/ai-runtime
COPY shared/extraction-runtime /app/shared/extraction-runtime
COPY customized-extraction/pyproject.toml customized-extraction/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY customized-extraction/src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev && useradd --create-home --uid 10001 extraction
USER extraction
CMD ["/app/customized-extraction/.venv/bin/customized-extraction-worker"]
