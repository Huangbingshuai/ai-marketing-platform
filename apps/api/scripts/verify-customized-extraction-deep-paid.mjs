// Real paid acceptance only. Persistent ledger makes polling/restarts non-generative.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, extname } from 'node:path';

assert.equal(process.env.CUSTOMIZED_EXTRACTION_PAID_TEST, '1');
const base = 'http://localhost:3100/api';
const directory =
  process.env.CUSTOMIZED_PAID_CASE_DIRECTORY || join(tmpdir(), 'customized-deep-paid-20261010');
const ledger = join(directory, 'ledger.json');
const mime = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};
async function request(path, method = 'GET', body, allowed = []) {
  const response = await fetch(base + path, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {},
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const json = await response.json();
  if (allowed.includes(response.status)) return { status: response.status, json };
  assert.ok(
    response.ok && json.success,
    `${method} ${path}: ${response.status} ${JSON.stringify(json)}`,
  );
  return json.data;
}
const cases = JSON.parse(await readFile(join(directory, 'cases.json'), 'utf8'));
let state;
try {
  state = JSON.parse(await readFile(ledger, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = {};
}
const persist = () => writeFile(ledger, JSON.stringify(state, null, 2));
const selected = process.env.CUSTOMIZED_DEEP_CASE;
assert.ok(!selected || cases.some((c) => c.name === selected), 'Unknown acceptance case');
if (process.argv.includes('--cancel-running')) {
  assert.equal(selected, '长文分片');
  const s = state[selected];
  assert.ok(s?.taskId);
  const root = `/projects/${s.projectId}/workflows/customized/information-extraction`;
  const probe = (s.cancellation ||= {});
  if (!probe.taskId) {
    const parent = await request(`${root}?workflowRunId=${s.runId}`);
    assert.equal(parent.task.status, 'COMPLETED');
    if (!parent.committed) {
      await request(`${root}/results/${parent.result.id}/confirm`, 'POST', {
        expectedRevision: parent.result.revision,
      });
    }
    probe.parentFields = parent.result.fields;
    probe.runId ||= (
      await request(root + '/edit', 'POST', { workflowRunId: s.runId })
    ).workflowRunId;
    probe.key ||= randomUUID();
    await persist();
    const input = (await request(`${root}?workflowRunId=${probe.runId}`)).source;
    probe.taskId = (
      await request(root + '/tasks', 'POST', {
        workflowRunId: probe.runId,
        sourceArtifactId: input.artifactId,
        sourceRevision: input.revision,
        idempotencyKey: probe.key,
      })
    ).task.id;
    await persist();
  }
  if (!probe.cancelledAt) {
    // A short bounded observation window; rerunning only resumes the existing probe.
    for (let i = 0; i < 16; i++) {
      const task = (await request(`${root}/tasks/${probe.taskId}`)).task;
      if (task.status === 'RUNNING' && task.currentNode === 'DOCUMENT_EXTRACT') {
        probe.runningObserved = true;
        const cancelled = await request(root + '/cancel-edit', 'POST', {
          workflowRunId: probe.runId,
        });
        assert.equal(cancelled.workflowRunId, s.runId);
        probe.cancelledAt = new Date().toISOString();
        await persist();
        break;
      }
      assert.ok(
        !['COMPLETED', 'FAILED'].includes(task.status),
        'Probe must cancel during execution',
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (probe.cancelledAt) {
    const parent = await request(`${root}?workflowRunId=${s.runId}`);
    assert.deepEqual(parent.result.fields, probe.parentFields);
    assert.equal(parent.committed, true);
    probe.parentVerifiedAt = new Date().toISOString();
    await persist();
  }
  console.log(
    JSON.stringify({
      taskId: probe.taskId,
      runningObserved: probe.runningObserved,
      cancelledAt: probe.cancelledAt,
      parentVerifiedAt: probe.parentVerifiedAt,
    }),
  );
  process.exit(0);
}
for (const scenario of cases.filter((c) => !selected || c.name === selected)) {
  const s = (state[scenario.name] ||= { key: randomUUID(), assets: [] });
  if (!s.projectId) {
    s.projectId = (
      await request('/projects', 'POST', {
        name: `${process.env.CUSTOMIZED_PAID_PROJECT_PREFIX || '提炼深度验收'}-${scenario.name}-20261010`,
        workflow: 'CUSTOMIZED',
        space: 'CUSTOMIZED_PROJECT',
      })
    ).id;
    await persist();
  }
  const p = s.projectId;
  if (!s.runId) {
    s.runId = (await request(`/projects/${p}/workflow-runs/customized/draft`, 'POST')).run.id;
    await persist();
  }
  const r = s.runId;
  const root = `/projects/${p}/workflows/customized/information-extraction`;
  if (!s.source) {
    for (const file of scenario.files.slice(s.assets.length)) {
      const form = new FormData();
      form.set('section', 'BRIEF');
      form.set(
        'file',
        new Blob([await readFile(file)], { type: mime[extname(file)] }),
        basename(file),
      );
      const asset = await request(
        `/projects/${p}/workflows/customized/source-import/runs/${r}/materials`,
        'POST',
        form,
      );
      s.assets.push(asset.id);
      await persist();
    }
    const path = `/projects/${p}/workflow-runs/${r}/nodes/SOURCE_IMPORT/state`;
    const previous = await request(path, 'GET', undefined, [404]);
    const saved = await request(path, 'PUT', {
      expectedRevision: previous.status === 404 ? null : previous.revision,
      schemaVersion: 3,
      state: {
        schemaVersion: 3,
        requirements: '',
        materials: s.assets.map((assetId) => ({ assetId, assetVersion: 1, category: 'BRIEF' })),
      },
    });
    await request(`/projects/${p}/workflow-runs/customized/branches/${r}/source-version`, 'POST', {
      expectedRevision: saved.nodeState.revision,
    });
    s.source = (await request(`${root}?workflowRunId=${r}`)).source;
    await persist();
  }
  if (process.argv.includes('--reextract') && selected === scenario.name) {
    const old = (await request(`${root}/tasks/${s.taskId}`)).task;
    assert.ok(['COMPLETED', 'FAILED', 'PARTIAL'].includes(old.status));
    s.previous ||= [];
    s.previous.push({
      taskId: s.taskId,
      workspace: s.workspace,
      startedAt: s.startedAt,
      observedAt: s.observedAt,
    });
    s.taskId = null;
    s.key = randomUUID();
    delete s.workspace;
    await persist();
  }
  if (!s.taskId) {
    const body = {
      workflowRunId: r,
      sourceArtifactId: s.source.artifactId,
      sourceRevision: s.source.revision,
      idempotencyKey: s.key,
    };
    s.startedAt = new Date().toISOString();
    s.taskId = (await request(root + '/tasks', 'POST', body)).task.id;
    await persist();
    assert.equal((await request(root + '/tasks', 'POST', body)).task.id, s.taskId);
  }
  if (process.argv.includes('--retry') && selected === scenario.name) {
    s.retries ||= [];
    s.retries.push(new Date().toISOString());
    await persist();
    await request(`${root}/tasks/${s.taskId}/retry`, 'POST', {});
  }
  const workspace = await request(`${root}?workflowRunId=${r}`);
  if (process.argv.includes('--assert')) {
    assert.ok(
      ['COMPLETED', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(workspace.task?.status),
      `${scenario.name}: still running`,
    );
  }
  if (['COMPLETED', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(workspace.task?.status)) {
    s.workspace = workspace;
    s.observedAt ||= new Date().toISOString();
    await persist();
    if (process.argv.includes('--assert')) {
      assert.equal(workspace.task.status, scenario.expectedStatus, scenario.name);
      if (scenario.expectedStatus === 'COMPLETED') {
        assert.equal(workspace.task.id, s.taskId, `${scenario.name}: old task projection`);
        assert.deepEqual(workspace.source, s.source, `${scenario.name}: source snapshot changed`);
        assert.equal(workspace.result.sourceFingerprint, s.source.fingerprint);
        assert.equal(workspace.stale, false, `${scenario.name}: source unexpectedly stale`);
        if (scenario.requireUnconfirmed)
          assert.equal(workspace.committed, false, `${scenario.name}: AI must only save a draft`);
        for (const [field, fragments] of Object.entries(scenario.fieldExcludes || {})) {
          const value = JSON.stringify(workspace.result.fields[field]);
          for (const fragment of fragments)
            assert.ok(
              !value?.includes(fragment),
              `${scenario.name}.${field}: misplaced ${fragment}`,
            );
        }
        if (scenario.validateSources) {
          for (const [field, value] of Object.entries(workspace.result.fields)) {
            const sources = workspace.result.fieldSources[field];
            if (value.length)
              assert.ok(sources.length, `${scenario.name}.${field}: missing source`);
            for (const source of sources) {
              assert.ok(
                s.assets.includes(source.assetId),
                `${scenario.name}: cross-product source`,
              );
              assert.equal(source.assetVersion, 1);
              assert.ok(source.location.trim());
              if (field !== 'sellingPoints') assert.equal(source.itemIndex, null);
            }
            if (field === 'sellingPoints')
              assert.deepEqual(
                new Set(sources.map((source) => source.itemIndex)),
                new Set(value.map((_, index) => index)),
              );
          }
        }
        for (const [field, fragments] of Object.entries(scenario.fieldContains || {})) {
          const value = JSON.stringify(workspace.result.fields[field]);
          for (const fragment of fragments)
            assert.ok(value?.includes(fragment), `${scenario.name}.${field}: missing ${fragment}`);
        }
        for (const [field, value] of Object.entries(scenario.fieldEquals || {}))
          assert.deepEqual(workspace.result.fields[field], value, `${scenario.name}.${field}`);
        if (scenario.noBlockingIssues)
          assert.ok(
            !workspace.result.issues.some((issue) => issue.blocking),
            `${scenario.name}: unexpected blocking issue`,
          );
        const actual = JSON.stringify(
          scenario.conflict
            ? { fields: workspace.result.fields, issues: workspace.result.issues }
            : workspace.result.fields,
        );
        for (const fact of scenario.contains || [])
          assert.ok(actual.includes(fact), `${scenario.name}: missing ${fact}`);
        for (const example of scenario.excludes || [])
          assert.ok(!actual.includes(example), `${scenario.name}: example leaked ${example}`);
        if (scenario.sellingPoints)
          assert.equal(workspace.result.fields.sellingPoints.length, scenario.sellingPoints);
        if (scenario.conflict) {
          assert.ok(
            workspace.result.issues.some((i) => i.field === 'productSpecifications' && i.blocking),
          );
          for (const issue of workspace.result.issues.filter(
            (i) => i.field === 'productSpecifications',
          )) {
            assert.ok(
              issue.alternatives.every((value) => value.includes('12')),
              'Choosing a net-weight alternative must preserve the uncontested shelf life',
            );
          }
          const confirmation = await request(
            `${root}/results/${workspace.result.id}/confirm`,
            'POST',
            { expectedRevision: workspace.result.revision },
            [400],
          );
          assert.equal(confirmation.status, 400, 'Unresolved conflicts must block confirmation');
        }
      } else assert.equal(workspace.committed, false);
    }
  }
  console.log(
    JSON.stringify({
      name: scenario.name,
      taskId: s.taskId,
      status: workspace.task?.status,
      progress: workspace.task?.progress,
      node: workspace.task?.currentNode,
      fields: workspace.result?.fields,
      issues: workspace.result?.issues,
      error: workspace.task?.errorMessage,
    }),
  );
}
