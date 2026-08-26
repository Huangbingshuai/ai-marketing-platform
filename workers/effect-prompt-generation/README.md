# Effect Prompt Generation Worker

Independent Python 3.12 worker for the effect workflow's differentiated Prompt batch node.
It consumes lightweight run identifiers from RabbitMQ, claims an immutable snapshot from the
NestJS internal API, persists every shard, and returns only a schema-versioned batch result.

Schema V5 generates a material pool, not finished advertisements: one Prompt maps to one
independently renderable video fragment. The worker deterministically allocates the six
slot-compatible fragment types (`HOOK`, `PAIN`, `PRODUCT_DISPLAY`,
`SELLING_POINT_EXPLANATION`, `CTA`, `OUTRO`), stores their
material tags and the user-configured per-fragment duration, and replenishes deficits by type.
The candidate model returns `slotId + promptText + usedFactIds`; it cannot rewrite type, tags,
duration, six-dimensional planning, insight bindings, or evidence boundaries.

Visible Prompt text contains creative video content only. Duration stays on each item, while
ratio, resolution, and shared disabled elements live in the batch-level `renderProfile`.
The candidate-model instruction asks the model not to repeat those values in visible text and
passes shared disabled elements only as avoidance guidance. They are not execution-gate failures:
if the model still emits them, the item remains usable and the structured `renderProfile` remains
authoritative for rendering.
After three targeted AI replenishment rounds, a validated deterministic fallback fills each
fragment-type deficit. A batch is completed only when both the total and all six quotas match
exactly; an unsafe or still-short fallback fails the run without replacing the last valid result.

Before strategy planning, `INSIGHT_MAPPING` classifies every non-empty extraction field as
required, adaptive, excluded, or a global constraint and gives usable facts stable content-derived
IDs. Strategy returns relationship bundles that reference only those IDs, preserving the link
between audience, pain, decision driver, scenario, selling point, evidence, and marketing goal.
After deduplication, `INSIGHT_COVERAGE` measures the bindings that survived; missing required facts
drive role-compatible replenishment and block `PASS`, while deferred adaptive facts remain visible
without blocking the draft.

Only `STRATEGY_PLANNING` and the six fragment-specific generation branches call Ark. Strategy uses the lightweight
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
- `ARK_PROMPT_STRATEGY_MAX_OUTPUT_TOKENS` (default `8192`, accommodates V4 relationship bundles)
- `ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS` (default `4096`)
- `ARK_PROMPT_REASONING_EFFORT` (default `minimal`)
- `PROMPT_MAX_CONCURRENCY` (default `3`, range `1..8`)
- `PROMPT_SHARD_SIZE` (default `8`, range `1..8`)
- `PROMPT_MAX_AI_CALLS_PER_RUN` (default `129`)
- `INTERNAL_API_TIMEOUT_SECONDS`, `ARK_TIMEOUT_SECONDS`, `LOG_LEVEL`

The Docker Compose default for `ARK_PROMPT_STRATEGY_MAX_OUTPUT_TOKENS` must stay aligned
with the worker default (`8192`). V4 strategy responses can exceed the old 2048-token limit.
The worker rejects invalid relationship bundles individually and restores required coverage
only from confirmed fact IDs; a missing evidence row falls back to safe `TEXT_ONLY` wording.

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
