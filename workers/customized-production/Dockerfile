FROM ghcr.io/astral-sh/uv:0.11.16-python3.12-trixie-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app/customized-production
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY shared/customized-production-runtime/scripts/check-production-runtime.sh /usr/local/bin/check-production-runtime
RUN chmod 755 /usr/local/bin/check-production-runtime && check-production-runtime customized-production
COPY shared/ai-runtime /app/shared/ai-runtime
COPY shared/customized-production-runtime /app/shared/customized-production-runtime
COPY customized-production/pyproject.toml customized-production/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY customized-production/src ./src
RUN uv sync --frozen --no-dev && useradd --create-home --uid 10001 worker
USER worker
CMD ["/app/customized-production/.venv/bin/customized-production-worker"]
