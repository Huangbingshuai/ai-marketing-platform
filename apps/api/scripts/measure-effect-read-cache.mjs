// Read-only measurements: no generation, saving, activation, or cache flush.
// Usage: node apps/api/scripts/measure-effect-read-cache.mjs <projectId> [samples=10]
const base = process.env.EFFECT_BENCH_API_URL ?? 'http://localhost:3100/api';
const startedAt = new Date().toISOString();
const [projectId, sampleArgument = '10'] = process.argv.slice(2);
const samples = Number(sampleArgument);
if (!projectId || !Number.isInteger(samples) || samples < 1 || samples > 100) {
  throw new Error('Provide projectId and 1–100 samples');
}
const prefix = `/projects/${encodeURIComponent(projectId)}`;
async function read(path) {
  const started = performance.now();
  const response = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path.split('?')[0]}`);
  return {
    ms: performance.now() - started,
    bytes: Buffer.byteLength(text),
    cacheControl: response.headers.get('cache-control'),
    data: JSON.parse(text).data,
  };
}
const overview = (
  await read(`${prefix}/workflow-runs/active/overview?workflow=EFFECT&space=EFFECT`)
).data;
if (!overview.run) throw new Error('Project has no active Effect Run');
const runId = overview.run.id;
// getWorkspace/getDraft perform existing housekeeping, but do not create any paid task.
const workspace = (await read(`${prefix}/workflows/effect/source-import`)).data.workspace;
const draft = (
  await read(`${prefix}/workflows/effect/source-import/drafts/${workspace.currentMode}`)
).data;
const product = draft.products?.[0];
const paths = {
  import: `${prefix}/workflows/effect/source-import`,
  importDraft: `${prefix}/workflows/effect/source-import/drafts/${workspace.currentMode}`,
  extraction: `${prefix}/workflows/effect/information-extraction?draftId=${draft.id}`,
  prompt: `${prefix}/workflows/effect/prompt-generation?workflowRunId=${runId}`,
  ...(product
    ? {
        render: `${prefix}/workflows/effect/segment-render/products/${product.id}?workflowRunId=${runId}`,
      }
    : {}),
  mix: `${prefix}/workflows/effect/template-mix?workflowRunId=${runId}`,
  output: `${prefix}/workflows/effect/final-output?workflowRunId=${runId}`,
  tree: `${prefix}/workflow-runs/effect/branches`,
};
const report = [];
for (const [resource, path] of Object.entries(paths)) {
  const values = [];
  for (let index = 0; index < samples; index++) values.push(await read(path));
  const times = values.map(({ ms }) => ms).sort((a, b) => a - b);
  const percentile = (q) => Math.round(times[Math.ceil(q * times.length) - 1]);
  const warm = values
    .slice(1)
    .map(({ ms }) => ms)
    .sort((a, b) => a - b);
  const warmPercentile = (q) =>
    warm.length ? Math.round(warm[Math.ceil(q * warm.length) - 1]) : null;
  report.push({
    resource,
    samples,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    warmP50Ms: warmPercentile(0.5),
    warmP95Ms: warmPercentile(0.95),
    firstMs: Math.round(values[0].ms),
    bytes: values.at(-1).bytes,
    cacheControl: values.at(-1).cacheControl,
  });
}
console.log(JSON.stringify({ startedAt, measuredAt: new Date().toISOString(), report }, null, 2));
