// Explicitly authorized paid integration probe. IDs are persisted outside the repository.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

assert.equal(
  process.env.CUSTOMIZED_EXTRACTION_PAID_TEST,
  '1',
  'Set CUSTOMIZED_EXTRACTION_PAID_TEST=1 only with explicit paid authorization.',
);
const base = process.env.CUSTOMIZED_VERIFY_API_URL || 'http://localhost:3100/api';
const manifest =
  process.env.CUSTOMIZED_PAID_MANIFEST ||
  join(tmpdir(), 'customized-extraction-paid-20261010.json');
async function request(path, method = 'GET', body, allowMissing = false) {
  const response = await fetch(base + path, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const json = await response.json();
  if (allowMissing && response.status === 404) return null;
  assert.ok(
    response.ok && json.success,
    `${method} ${path}: ${response.status} ${JSON.stringify(json.error)}`,
  );
  return json.data;
}
let state;
try {
  state = JSON.parse(await readFile(manifest, 'utf8'));
} catch {
  state = { idempotencyKey: randomUUID() };
}
const persist = () => writeFile(manifest, JSON.stringify(state, null, 2));
if (!state.projectId) {
  state.projectId = (
    await request('/projects', 'POST', {
      name: process.env.CUSTOMIZED_PAID_PROJECT_NAME || '青梅酱信息提炼真实验收-20261010',
      workflow: 'CUSTOMIZED',
      space: 'CUSTOMIZED_PROJECT',
    })
  ).id;
  await persist();
}
const p = state.projectId;
if (!state.workflowRunId) {
  state.workflowRunId = (
    await request(`/projects/${p}/workflow-runs/customized/draft`, 'POST')
  ).run.id;
  await persist();
}
const r = state.workflowRunId;
const root = `/projects/${p}/workflows/customized/information-extraction`;
if (process.argv.includes('--reextract')) {
  const old = (await request(`${root}/tasks/${state.taskId}`)).task;
  assert.ok(['COMPLETED', 'FAILED', 'PARTIAL'].includes(old.status));
  state.previousTasks = [...(state.previousTasks || []), state.taskId];
  state.taskId = null;
  state.idempotencyKey = randomUUID();
  await persist();
}
if (!state.source) {
  const filePath =
    process.env.CUSTOMIZED_PAID_DOCUMENT || '素材/定制类项目素材/09青梅酱/视频创作简报.docx';
  if (!state.assetId) {
    const form = new FormData();
    form.set('section', 'BRIEF');
    form.set(
      'file',
      new Blob([await readFile(filePath)], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      basename(filePath),
    );
    state.assetId = (
      await request(
        `/projects/${p}/workflows/customized/source-import/runs/${r}/materials`,
        'POST',
        form,
      )
    ).id;
    await persist();
  }
  const path = `/projects/${p}/workflow-runs/${r}/nodes/SOURCE_IMPORT/state`;
  const previous = await request(path, 'GET', undefined, true);
  const draft = await request(path, 'PUT', {
    expectedRevision: previous?.revision ?? null,
    schemaVersion: 3,
    state: {
      schemaVersion: 3,
      requirements: '',
      materials: [{ assetId: state.assetId, assetVersion: 1, category: 'BRIEF' }],
    },
  });
  await request(`/projects/${p}/workflow-runs/customized/branches/${r}/source-version`, 'POST', {
    expectedRevision: draft.nodeState.revision,
  });
  state.source = (await request(`${root}?workflowRunId=${r}`)).source;
  await persist();
}
if (!state.taskId) {
  const body = {
    workflowRunId: r,
    sourceArtifactId: state.source.artifactId,
    sourceRevision: state.source.revision,
    idempotencyKey: state.idempotencyKey,
  };
  state.taskId = (await request(root + '/tasks', 'POST', body)).task.id;
  await persist();
  assert.equal(
    (await request(root + '/tasks', 'POST', body)).task.id,
    state.taskId,
    'duplicate start must reuse task',
  );
}
const task = (await request(`${root}/tasks/${state.taskId}`)).task;
console.log(
  JSON.stringify(
    {
      manifest,
      ...state,
      task: {
        status: task.status,
        progress: task.progress,
        currentNode: task.currentNode,
        errorMessage: task.errorMessage,
      },
    },
    null,
    2,
  ),
);
if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(task.status)) {
  const workspace = await request(`${root}?workflowRunId=${r}`);
  await writeFile(manifest.replace('.json', '-result.json'), JSON.stringify(workspace, null, 2));
  console.log(
    JSON.stringify(
      {
        fields: workspace.result?.fields,
        issues: workspace.result?.issues,
        revision: workspace.result?.revision,
        committed: workspace.committed,
        stale: workspace.stale,
      },
      null,
      2,
    ),
  );
}
