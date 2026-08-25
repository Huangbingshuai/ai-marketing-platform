# Effect Prompt Generation Worker

Independent Python 3.12 worker for the effect workflow's differentiated Prompt batch node.
It consumes lightweight run identifiers from RabbitMQ, claims an immutable snapshot from the
NestJS internal API, persists every shard, and returns only a schema-versioned batch result.

Required environment variables:

- `INTERNAL_API_BASE_URL`
- `EFFECT_PROMPT_WORKER_TOKEN`
- `RABBITMQ_URL`
- `ARK_API_KEY` when `PROMPT_AI_PROVIDER=ark`

Optional environment variables:

- `EFFECT_PROMPT_QUEUE` (default `effect.prompt-generation.requested`)
- `PROMPT_AI_PROVIDER` (`ark` by default; `mock` must be explicit)
- `ARK_BASE_URL`, `ARK_MODEL`, `ARK_PROMPT_MODEL`
- `PROMPT_MAX_CONCURRENCY` (default `3`, range `1..8`)
- `PROMPT_SHARD_SIZE` (default `8`, range `1..8`)
- `INTERNAL_API_TIMEOUT_SECONDS`, `ARK_TIMEOUT_SECONDS`, `LOG_LEVEL`

Local verification:

```powershell
uv run --frozen pytest
uv run --frozen mypy src tests
```
