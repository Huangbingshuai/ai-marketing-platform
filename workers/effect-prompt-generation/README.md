# Effect Prompt Generation Worker

Independent Python 3.12 worker for the effect workflow's differentiated Prompt batch node.
It consumes lightweight run identifiers from RabbitMQ, claims an immutable snapshot from the
NestJS internal API, persists every shard, and returns only a schema-versioned batch result.

Schema V2 generates a material pool, not finished advertisements: one Prompt maps to one
independently renderable video fragment. The worker deterministically allocates the seven
slot-compatible fragment types (`HOOK`, `PAIN`, `PRODUCT_DISPLAY`,
`EFFECT_DEMONSTRATION`, `SELLING_POINT_EXPLANATION`, `CTA`, `OUTRO`), stores their
material tags and the user-configured per-fragment duration, and replenishes deficits by type.
The candidate model returns only `slotId + promptText`; it cannot rewrite type, tags,
duration, six-dimensional planning, or evidence boundaries.

Only `STRATEGY_PLANNING` and `CANDIDATE_GENERATION` call Ark. Strategy uses the lightweight
model to classify confirmed selling points into `VISIBLE_ATTRIBUTE`, `USAGE_ACTION`,
`VISIBLE_RESULT`, `PROCESS_ONLY`, or `TEXT_ONLY` evidence modes and to plan concrete
single-person actions. Combination, execution validation, similarity checks, quotas,
replenishment, and persistence are deterministic. Prompts containing a full timeline,
stacked personas, meta-language, unfilmable evidence, role conflicts, field duplication,
source-fact violations, placeholders, or broken text are removed before similarity checks.

Required environment variables:

- `INTERNAL_API_BASE_URL`
- `EFFECT_PROMPT_WORKER_TOKEN`
- `RABBITMQ_URL`
- `ARK_API_KEY` when `PROMPT_AI_PROVIDER=ark`

Optional environment variables:

- `EFFECT_PROMPT_QUEUE` (default `effect.prompt-generation.requested`)
- `PROMPT_AI_PROVIDER` (`ark` by default; `mock` must be explicit)
- `ARK_BASE_URL`, `ARK_MODEL`
- `ARK_PROMPT_STRATEGY_MODEL`: strategy-node override; when unset it uses legacy
  `ARK_PROMPT_MODEL`, then the verified lightweight default
  `doubao-seed-2-0-lite-260428`
- `ARK_PROMPT_CANDIDATE_MODEL`: candidate-node override; when unset it uses legacy
  `ARK_PROMPT_MODEL`, then `ARK_MODEL` (Seed 2.1 Turbo by default)
- `ARK_PROMPT_STRATEGY_MAX_OUTPUT_TOKENS` (default `2048`)
- `ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS` (default `4096`)
- `ARK_PROMPT_REASONING_EFFORT` (default `minimal`)
- `PROMPT_MAX_CONCURRENCY` (default `3`, range `1..8`)
- `PROMPT_SHARD_SIZE` (default `8`, range `1..8`)
- `PROMPT_MAX_AI_CALLS_PER_RUN` (default `129`)
- `INTERNAL_API_TIMEOUT_SECONDS`, `ARK_TIMEOUT_SECONDS`, `LOG_LEVEL`

`PROMPT_MAX_AI_CALLS_PER_RUN` is an abnormal-loop fuse, not the normal usage budget. Its
default covers one strategy call plus the theoretical maximum of four 32-shard candidate
rounds for a 200-item request. Deployments may lower it; the pipeline truncates additional
shards and preserves the best available `NEEDS_REVIEW` draft instead of throwing away useful
candidates. Per-call output limits and three replenishment rounds remain the primary cost
controls. Safe logs keep stage, attempt, latency, and token counts only; there is no hard total
token budget because interrupting a run mid-batch would discard otherwise recoverable partial
results.

Local verification:

```powershell
uv run --frozen pytest
uv run --frozen mypy src tests
```
