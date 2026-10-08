// Actual HTTP responses versus live Redis entries; no writes, flush, user content or key logging.
// Pair this with EFFECT_READ_CACHE_LOG_METRICS=true to verify server-side hit outcomes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClient } from 'redis';

const [projectId] = process.argv.slice(2);
assert.match(
  projectId ?? '',
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'Provide projectId',
);
const base = process.env.EFFECT_BENCH_API_URL ?? 'http://localhost:3100/api';
const namespace = process.env.EFFECT_READ_CACHE_NAMESPACE ?? 'amp:effect-read:v1';
assert.match(namespace, /^[a-z0-9:_-]+$/i, 'Namespace must be a literal SCAN prefix');
const prefix = `/projects/${projectId}`;
const hash = (body) => createHash('sha256').update(body).digest('hex');
async function read(path) {
  const start = performance.now();
  const response = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, 'Business HTTP read must succeed');
  const { data } = await response.json();
  return { ms: Math.round(performance.now() - start), data, hash: hash(JSON.stringify(data)) };
}
const overview = await read(`${prefix}/workflow-runs/active/overview?workflow=EFFECT&space=EFFECT`);
assert.ok(overview.data.run?.id, 'Project must have an active Effect Run');
const runId = overview.data.run.id;
const client = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  disableOfflineQueue: true,
  socket: { connectTimeout: 1000, reconnectStrategy: false },
});
client.on('error', () => {});
// Overall bound includes SCAN/GET; never leave a dead connection waiting indefinitely.
const deadline = setTimeout(() => {
  if (client.isOpen) client.destroy();
}, 60_000);
try {
  await client.connect();
  const report = [];
  for (const [resource, path] of Object.entries({
    mix: `${prefix}/workflows/effect/template-mix?workflowRunId=${runId}`,
    output: `${prefix}/workflows/effect/final-output?workflowRunId=${runId}`,
    tree: `${prefix}/workflow-runs/effect/branches`,
  })) {
    const first = await read(path);
    const second = await read(path);
    assert.equal(
      second.hash,
      first.hash,
      `${resource}: repeated responses differ; retry without concurrent edits`,
    );
    const matches = [];
    for await (const keys of client.scanIterator({
      MATCH: `${namespace}:${projectId}:EFFECT:${runId}:${resource}:*`,
      COUNT: 100,
    })) {
      for (const key of keys) {
        if (key.endsWith(':fill')) continue;
        const raw = await client.get(key);
        if (!raw) continue;
        const envelope = JSON.parse(raw);
        if (envelope.schema !== 2) continue;
        const payload = JSON.parse(envelope.body);
        if (payload.kind !== 'value' || hash(JSON.stringify(payload.value)) !== second.hash)
          continue;
        assert.equal(
          hash(envelope.body),
          envelope.checksum,
          'Redis envelope checksum must match body',
        );
        assert.equal(
          key.split(':').at(-1),
          envelope.version,
          'Redis key must contain authoritative version',
        );
        const ttl = await client.ttl(key);
        assert.ok(ttl > 0, 'Every cached projection must expire');
        matches.push({ ttlSeconds: ttl, bytes: Buffer.byteLength(envelope.body) });
      }
    }
    assert.ok(matches.length, `${resource}: no live Redis entry matching actual HTTP response`);
    report.push({
      resource,
      firstMs: first.ms,
      secondMs: second.ms,
      matchingRedisEntries: matches.length,
      ...matches[0],
    });
  }
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        scope:
          'Actual API response equality, Redis version/checksum/TTL; server hit logs checked separately',
        report,
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Do not include Redis client errors, connection strings, cache values or raw URLs.
  console.error(
    error instanceof assert.AssertionError ? error.message : 'Redis HTTP verification unavailable',
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (client.isOpen) client.destroy();
}
