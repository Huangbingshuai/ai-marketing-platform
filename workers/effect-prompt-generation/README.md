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
V9 historical runs retain their validated deterministic fallback. V10 never fabricates a
replacement Prompt: after a Prompt or orthogonal-gate rejection it removes the rejected blueprint,
returns to the same fragment type and relationship bundle, and generates `ceil(gap * 1.25)` new
blueprint candidates for at most three rounds. Only hard execution or exact-duplicate failures
can create a quantity gap; a still-short run preserves the best
`NEEDS_REVIEW` draft without committing it as a valid batch.

Before planning, `INSIGHT_MAPPING` classifies every non-empty extraction field as
required, adaptive, excluded, or a global constraint and gives usable facts stable content-derived
IDs. V10 keeps six independent relationship branches, but each branch now returns facts only:
`bundleId + fragmentType + primaryFactId + factIds + creativeIntent`. Six further coordinate calls
produce one product-specific six-dimensional coordinate plan per fragment type. Deterministic quota
allocation then expands every relationship bundle into exact blueprint tasks; type-homogeneous
blueprint shards (at most eight tasks) let the Lite model select one coherent six-coordinate tuple
and define its opening state, continuous action arc, and ending state. A full-batch diversity gate
compares normalized coordinate text across types and prefers blueprints whose minimum distance is
larger, but does not delete an otherwise distinct blueprint merely because one pair differs in fewer
than three dimensions. Exact fragment counts and relationship quotas come first. One accepted
blueprint produces exactly one Turbo Prompt task.
After deduplication, `INSIGHT_COVERAGE` measures the bindings that survived; missing required facts
drive role- and relationship-compatible blueprint replenishment and block `PASS`, while deferred
adaptive facts remain visible without blocking the draft. V9 remains available only for frozen
historical runs; new V10 runs use independent `BLUEPRINT` and `PROMPT` shard phases, plus relationship
and coordinate stage checkpoints.

Only the six relationship branches, six coordinate branches, type-homogeneous blueprint shards,
and final Prompt shards call Ark. The Lite model plans fact relationships, coordinates, and
blueprints; the Turbo model writes the final fragment Prompt. The worker classifies
evidence into `VISIBLE_ATTRIBUTE`, `USAGE_ACTION`, `VISIBLE_RESULT`, `PROCESS_ONLY`, or
`TEXT_ONLY`. Combination, execution validation, similarity checks, quotas,
replenishment, and persistence are deterministic. Prompts containing a full timeline,
stacked personas, meta-language, unfilmable evidence, role conflicts, field duplication,
source-fact violations, placeholders, or broken text are removed before similarity checks.
Semantic and visual similarity are measured across the complete batch against the user-configured
pair-rate limits; an individual similar pair is not an automatic deletion.

Required environment variables:

- `INTERNAL_API_BASE_URL`
- `EFFECT_PROMPT_WORKER_TOKEN`
- `RABBITMQ_URL`
- `ARK_API_KEY` when `PROMPT_AI_PROVIDER=ark`

Optional environment variables:

- `EFFECT_PROMPT_QUEUE` (default `effect.prompt-generation.requested`)
- `PROMPT_AI_PROVIDER` (`ark` by default; `mock` must be explicit)
- `ARK_BASE_URL`, `ARK_MODEL`
- `ARK_PROMPT_STRATEGY_MODEL`: relationship and coordinate planning override; defaults to
  Doubao Seed 2.0 Lite
- `ARK_PROMPT_BLUEPRINT_MODEL`: blueprint override; when unset it follows the strategy model
- `ARK_PROMPT_FRAGMENT_STRATEGY_MODEL`: six-branch planning override; when unset it follows
  the candidate Turbo model
- `ARK_PROMPT_CANDIDATE_MODEL`: candidate-node override; when unset it uses legacy
  `ARK_PROMPT_MODEL`, then `ARK_MODEL` (Seed 2.1 Turbo by default)
- `ARK_PROMPT_FRAGMENT_STRATEGY_MAX_OUTPUT_TOKENS` (default `3072` per branch)
- `ARK_PROMPT_CANDIDATE_MAX_OUTPUT_TOKENS` (default `4096`)
- `ARK_PROMPT_REASONING_EFFORT` (default `minimal`)
- `ARK_PROMPT_FRAGMENT_STRATEGY_TIMEOUT_SECONDS` (default `120` per branch)
- `ARK_PROMPT_CANDIDATE_TIMEOUT_SECONDS` (default `120`)
- `ARK_PROMPT_PROVIDER_MAX_ATTEMPTS` (default `1`)
- `PROMPT_MAX_CONCURRENCY` (default `6`, range `1..8`; allows all six marketing-planning branches to run in parallel)
- `PROMPT_SHARD_SIZE` (default `8`, range `1..8`)
- `PROMPT_MAX_AI_CALLS_PER_RUN` (default `256`)
- `INTERNAL_API_TIMEOUT_SECONDS`, `ARK_TIMEOUT_SECONDS`, `LOG_LEVEL`

The provider checks Ark `status` and
`incomplete_details` before parsing JSON: output-limit truncation fails immediately with
`AI_OUTPUT_TRUNCATED` instead of repeating the same oversized request.
The worker rejects a fragment planning branch when it contains unknown facts, role conflicts,
duplicate masters, missing mandatory facts, or unsafe evidence. Successful branches are checkpointed
with source, allocation, and prompt-version hashes so task retry reuses them without storing raw model output.
Candidate `usedFactIds` are normalized back to the immutable worker blueprint, so a model cannot
rewrite fact bindings or abort an otherwise valid batch by altering an internal ID.

`PROMPT_MAX_AI_CALLS_PER_RUN` is an abnormal-loop fuse, not the normal usage budget. A default
50-item V10 run makes 6 relationship + 6 coordinate + 9 blueprint + 9 Prompt calls (30 total).
At the legal 200-item ceiling, the conservative four-round upper bound is 240 calls:
12 planning calls, at most 30 initial blueprint and 30 initial Prompt shards, plus three rounds
of at most 36 replenishment-blueprint and 30 replenishment-Prompt shards. The default 256 leaves
headroom while keeping the run bounded. Deployments may lower it; the pipeline truncates additional
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
