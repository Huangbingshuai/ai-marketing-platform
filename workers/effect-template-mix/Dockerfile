FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project
COPY src ./src
RUN uv sync --no-dev
CMD ["/app/.venv/bin/effect-template-mix-worker"]
