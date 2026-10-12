// Explicitly authorized paid integration; never enable this in the default test suite.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

assert.equal(
  process.env.CUSTOMIZED_STORYBOARD_PAID_TEST,
  '1',
  'Explicit paid authorization required.',
);
const option = (name, fallback) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const base = process.env.CUSTOMIZED_VERIFY_API_URL || 'http://localhost:3100/api';
const manifest = resolve(option('manifest', 'tmp/customized-storyboard-paid-20261012.json'));
let state;
try {
  state = JSON.parse(await readFile(manifest, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const persist = async () => {
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(manifest, JSON.stringify(state, null, 2) + '\n');
};
const request = async (path, method = 'GET', body) => {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      response = await fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000),
      });
      if (method === 'GET' && response.status >= 500 && attempt < 5) {
        await new Promise((done) => setTimeout(done, Math.min(8000, 1000 * 2 ** attempt)));
        continue;
      }
      break;
    } catch (error) {
      if (method !== 'GET' || attempt === 5) throw error;
      await new Promise((done) => setTimeout(done, Math.min(8000, 1000 * 2 ** attempt)));
    }
  }
  const json = await response.json();
  assert.ok(
    response.ok && json.success,
    `${method} ${path}: HTTP ${response.status}, code=${json.error?.code ?? 'unknown'}`,
  );
  return json.data;
};
if (!state) {
  assert.ok(option('project'), '--project is required for a confirmed test Brief.');
  assert.ok(option('run'), '--run is required.');
  state = {
    projectId: option('project'),
    workflowRunId: option('run'),
    idempotencyKey: randomUUID(),
    startedAt: new Date().toISOString(),
    observations: [],
    published: [],
  };
  await persist();
}
const root = `/projects/${state.projectId}/workflows/customized/storyboard`;
if (state.taskId && process.argv.includes('--retry')) {
  const previous = await request(`${root}/tasks/${state.taskId}`);
  assert.ok(
    ['FAILED', 'PARTIAL', 'CANCELLED'].includes(previous.status),
    'Retry only a terminal incomplete task.',
  );
  await request(`${root}/tasks/${state.taskId}/retry`, 'POST');
  state.recoveries = [...(state.recoveries || []), new Date().toISOString()];
  await persist();
}
if (!state.taskId) {
  const workspace = await request(`${root}?workflowRunId=${state.workflowRunId}`);
  assert.ok(workspace.sourceReady && workspace.source, 'A valid confirmed Brief is required.');
  assert.ok(!workspace.scripts.some((s) => s.editing), 'Do not modify an active user edit.');
  state.source = workspace.source;
  state.productName = workspace.brief.productName;
  state.previousScriptIds = workspace.scripts.map((s) => s.id);
  state.settings = {
    ...workspace.settings,
    targetDurationSeconds: Number(option('seconds', '30')),
    variantCount: Number(option('count', '3')),
    structureMode: option('mode', 'AI'),
    structure: option('structure', ''),
    instructions: option('instructions', ''),
  };
  const saved = await request(`${root}/settings`, 'PUT', {
    workflowRunId: state.workflowRunId,
    expectedRevision: workspace.settingsRevision,
    settings: state.settings,
    selectedScriptId: workspace.selectedScriptId,
  });
  const body = {
    workflowRunId: state.workflowRunId,
    expectedRevision: saved.revision,
    idempotencyKey: state.idempotencyKey,
  };
  const task = await request(`${root}/tasks`, 'POST', body);
  state.taskId = task.id;
  state.createdAt = task.createdAt;
  await persist();
  assert.equal(
    (await request(`${root}/tasks`, 'POST', body)).id,
    task.id,
    'Duplicate creation must reuse task.',
  );
  console.log(
    JSON.stringify({
      event: 'started',
      product: state.productName,
      taskId: state.taskId,
      settings: state.settings,
    }),
  );
}
let previous = '';
for (;;) {
  const task = await request(`${root}/tasks/${state.taskId}`);
  const workspace = await request(`${root}?workflowRunId=${state.workflowRunId}`);
  const status = JSON.stringify({
    status: task.status,
    progress: task.progress,
    stages: task.steps
      .filter((s) => s.status !== 'PENDING')
      .map((s) => [s.nodeId, s.scriptId, s.status]),
  });
  if (status !== previous) {
    previous = status;
    state.observations.push({
      at: new Date().toISOString(),
      status: task.status,
      progress: task.progress,
      stages: task.steps.map(({ nodeId, scriptId, status }) => ({ nodeId, scriptId, status })),
    });
    console.log(
      JSON.stringify({
        event: 'progress',
        status: task.status,
        progress: task.progress,
        running: task.steps.filter((s) => s.status === 'RUNNING').map((s) => s.nodeId),
      }),
    );
  }
  for (const script of workspace.scripts.filter(
    (s) =>
      s.taskId === state.taskId &&
      s.workflowRunId &&
      !state.published.some((p) => p.scriptId === s.id),
  )) {
    const entry = {
      scriptId: script.id,
      name: script.script.name,
      workflowRunId: script.workflowRunId,
      revision: script.confirmedRevision,
      shots: script.script.shots.length,
      duration: script.script.shots.reduce((sum, s) => sum + s.durationSeconds, 0),
      observedAt: new Date().toISOString(),
      batchStatus: task.status,
    };
    state.published.push(entry);
    console.log(JSON.stringify({ event: 'published', ...entry }));
  }
  state.status = task.status;
  state.errorMessage = task.errorMessage;
  await persist();
  if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(task.status)) {
    state.finishedAt = task.updatedAt;
    state.elapsedSeconds = Math.round(
      (Date.parse(state.finishedAt) - Date.parse(state.startedAt)) / 1000,
    );
    state.scripts = workspace.scripts.filter((s) => s.taskId === state.taskId);
    state.details = [];
    for (const nodeId of [
      'SNAPSHOT',
      'CONCEPT',
      'STORY',
      'ASSETS',
      'SHOTS',
      'REVIEW',
      'REPAIR',
      'SAVE',
    ]) {
      for (const scriptId of nodeId === 'SNAPSHOT' || nodeId === 'CONCEPT'
        ? [undefined]
        : [...new Set(task.steps.map((s) => s.scriptId).filter(Boolean))]) {
        let page = 0,
          detail;
        do {
          detail = await request(
            `${root}/tasks/${state.taskId}/nodes/${nodeId}?page=${page}${scriptId ? `&scriptId=${scriptId}` : ''}`,
          );
          state.details.push(detail);
          page += 1;
          assert.ok(page < 1000, 'Unbounded node pagination.');
        } while (detail.hasMore);
      }
    }
    assert.ok(
      state.previousScriptIds.every((id) => workspace.scripts.some((s) => s.id === id)),
      'Existing scripts must remain.',
    );
    for (const script of state.scripts.filter((s) => s.workflowRunId)) {
      assert.equal(script.source.artifactId, state.source.artifactId);
      assert.equal(script.source.revision, state.source.revision);
      assert.ok(
        Math.abs(
          script.script.shots.reduce((sum, s) => sum + s.durationSeconds, 0) -
            state.settings.targetDurationSeconds,
        ) <= 1,
      );
    }
    await persist();
    console.log(
      JSON.stringify({
        event: 'finished',
        status: task.status,
        elapsedSeconds: state.elapsedSeconds,
        published: state.published.length,
        manifest,
      }),
    );
    if (task.status !== 'COMPLETED') process.exitCode = 2;
    break;
  }
  if (Date.now() - Date.parse(state.startedAt) > 45 * 60 * 1000)
    throw new Error(
      'Observation window exceeded; task remains recoverable, inspect manifest before restarting.',
    );
  await new Promise((done) => setTimeout(done, 10000));
}
