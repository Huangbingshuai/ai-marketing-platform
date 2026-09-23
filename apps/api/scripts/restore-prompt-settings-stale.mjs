// Incident recovery only: no generation, revision changes, dependency rebinding or file writes.
// Dry-run by default. Supply the exact invalidation window after investigating its cause.
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import pg from 'pg';

try {
  loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const args = process.argv.slice(2);
const option = (name) =>
  args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const projectId = option('project');
const workflowRunId = option('run');
const after = option('after');
const before = option('before');
const apply = args.includes('--apply');
if (
  ![projectId, workflowRunId].every((id) => /^[a-f0-9-]{36}$/.test(id ?? '')) ||
  !after ||
  !before ||
  !Number.isFinite(Date.parse(after)) ||
  !Number.isFinite(Date.parse(before)) ||
  Date.parse(before) <= Date.parse(after) ||
  Date.parse(before) - Date.parse(after) > 60_000
)
  throw new Error(
    'Require project/run UUIDs and an investigated incident window of at most 60 seconds',
  );
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const scope = [projectId, workflowRunId];
  const { rows: artifacts } = await db.query(
    `SELECT *, ("updatedAt" >= ($3::timestamptz AT TIME ZONE 'UTC') AND
      "updatedAt" < ($4::timestamptz AT TIME ZONE 'UTC')) AS incident
      FROM working_artifacts WHERE "projectId"=$1 AND "workflowRunId"=$2 FOR UPDATE`,
    [...scope, after, before],
  );
  const { rows: dependencies } = await db.query(
    'SELECT * FROM working_artifact_dependencies WHERE "projectId"=$1 AND "workflowRunId"=$2 FOR SHARE',
    scope,
  );
  const { rows: states } = await db.query(
    'SELECT * FROM workflow_node_states WHERE "projectId"=$1 AND "workflowRunId"=$2 FOR SHARE',
    scope,
  );
  const { rows: files } = await db.query(
    `SELECT l."workingArtifactId", f.id, f.status FROM working_artifact_files l
     JOIN file_objects f ON f.id=l."fileObjectId" AND f."projectId"=l."projectId" AND f."workflowRunId"=l."workflowRunId"
     WHERE l."projectId"=$1 AND l."workflowRunId"=$2 FOR SHARE OF l,f`,
    scope,
  );
  const { rows: legacyFiles } = await db.query(
    `SELECT a.id AS "workingArtifactId", f.id, f.status FROM working_artifacts a
     JOIN file_objects f ON f.id::text=a.payload->>'fileObjectId' AND f."projectId"=a."projectId"
       AND f."workflowRunId"=a."workflowRunId" AND f."storageKey"=a."storageKey"
     WHERE a."projectId"=$1 AND a."workflowRunId"=$2 FOR SHARE OF f`,
    scope,
  );
  files.push(...legacyFiles);
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const byNode = new Map(states.map((s) => [s.nodeId, s]));
  const restored = new Set();
  const candidates = artifacts.filter(
    (a) =>
      a.freshness === 'STALE' &&
      a.availability === 'AVAILABLE' &&
      ['PROMPT_GENERATION', 'SEGMENT_RENDER'].includes(a.nodeId) &&
      a.incident,
  );
  const readable = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const artifact of candidates) {
      if (restored.has(artifact.id)) continue;
      const deps = dependencies.filter((d) => d.dependentArtifactId === artifact.id);
      if (
        !deps.length ||
        !deps.every((d) => {
          if (d.sourceType === 'WORKING_ARTIFACT') {
            const source = byId.get(d.sourceArtifactId);
            return (
              source &&
              source.revision === d.sourceRevision &&
              source.artifactKey === d.sourceKey &&
              (!d.sourceHash || source.contentHash === d.sourceHash) &&
              source.availability === 'AVAILABLE' &&
              (source.freshness === 'CURRENT' || restored.has(source.id))
            );
          }
          const state = byNode.get(d.sourceNodeId ?? d.sourceKey);
          return (
            state &&
            (d.sourceType === 'EXECUTION_INPUT'
              ? Boolean(d.sourceHash) && state.executionInputHash === d.sourceHash
              : state.revision === d.sourceRevision)
          );
        })
      )
        continue;
      const linked = files.filter((f) => f.workingArtifactId === artifact.id);
      // Clip restoration requires a persisted, available and actually readable media file.
      if (artifact.artifactKey.startsWith('render-clip:') && !linked.length) continue;
      if (linked.some((f) => f.status !== 'AVAILABLE')) continue;
      for (const file of linked) {
        if (readable.has(file.id)) continue;
        const response = await fetch(
          `http://localhost:${process.env.API_PORT ?? 3100}/api/projects/${projectId}/file-objects/${file.id}/content`,
          { headers: { Range: 'bytes=0-63' }, signal: AbortSignal.timeout(10000) },
        );
        if (!response.ok) throw new Error(`Media read failed: ${file.id} HTTP ${response.status}`);
        const reader = response.body.getReader();
        const chunk = await reader.read();
        await reader.cancel();
        if (!chunk.value?.byteLength) throw new Error(`Empty media: ${file.id}`);
        readable.add(file.id);
      }
      restored.add(artifact.id);
      changed = true;
    }
  }
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    projectId,
    workflowRunId,
    candidates: candidates.length,
    restored: restored.size,
    skipped: candidates.length - restored.size,
    readableFiles: readable.size,
    byNode: [...restored].reduce((counts, id) => {
      const node = byId.get(id).nodeId;
      counts[node] = (counts[node] ?? 0) + 1;
      return counts;
    }, {}),
  };
  if (apply && restored.size) {
    await db.query(
      `UPDATE working_artifacts SET freshness='CURRENT'
      WHERE "projectId"=$1 AND "workflowRunId"=$2 AND id=ANY($3::uuid[]) AND freshness='STALE'`,
      [projectId, workflowRunId, [...restored]],
    );
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify(report));
} catch (error) {
  await db.query('ROLLBACK');
  console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[database]'));
  process.exitCode = 1;
} finally {
  await db.end();
}
