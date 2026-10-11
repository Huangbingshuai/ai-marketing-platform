// Real provider acceptance probe. Never mutates the source project or shares its storage keys.
// Run only with explicit paid authorization; fixture and run IDs stay in the OS temporary folder.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Readable } from 'node:stream';

try { loadEnvFile(resolve(import.meta.dirname, '../../../.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.equal(process.env.EFFECT_PACKAGING_PAID_TEST, '1', 'Explicit paid-test authorization required');
const require = createRequire(import.meta.url);
const compiled = process.env.PACKAGING_VERIFY_COMPILED || '../dist-dev';
const { ConfigService } = require('@nestjs/config');
const { PrismaService } = require(`${compiled}/database/prisma.service.js`);
const { workflowStateHash } = require(`${compiled}/platform/workflow/workflow-state-hash.js`);
const { templateConfigurationHash } = require(`${compiled}/workflows/effect/template-mix/template-mix-lifecycle.js`);
const { TosStorageAdapter, createTosClient } = require(`${compiled}/platform/file/tos-storage.adapter.js`);
const { LocalStorageAdapter } = require(`${compiled}/platform/file/local-storage.adapter.js`);
const config = new ConfigService(process.env);
const db = new PrismaService(config);
const base = process.env.PACKAGING_VERIFY_API_URL || 'http://localhost:3100/api';
const manifest = process.env.PACKAGING_PAID_MANIFEST || join(tmpdir(), 'effect-packaging-paid-20261011.json');
let state;
try { state = JSON.parse(await readFile(manifest, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = {}; }
const persist = () => writeFile(manifest, JSON.stringify(state, null, 2));
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, { method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  assert.ok(response.ok && result.success, `${method} ${path}: ${response.status} ${JSON.stringify(result.error)}`);
  return result.data;
}
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
async function verifyResults() {
  const batch = await db.effectPackagingRun.findUniqueOrThrow({ where: { id: state.batchRunId }, include: { items: true } });
  const singles = await db.effectPackagingRun.findMany({ where: { projectId: state.projectId,
    workflowRunId: batch.workflowRunId }, include: { items: true }, orderBy: { createdAt: 'desc' } });
  const single = singles.find((run) => run.items[0]?.snapshot?.operation === 'SINGLE_PACKAGE');
  assert.ok(single, 'Run the single-film probe through the real toolbar first');
  state.singleRunId = single.id;
  await persist();
  assert.equal(batch.status, 'COMPLETED');
  assert.equal(batch.items.length, 2);
  assert.equal(single.status, 'COMPLETED');
  assert.equal(single.items.length, 1);
  assert.equal(single.items[0].variantId, state.variantIds[0]);
  const branch = await db.workflowRun.findUniqueOrThrow({ where: { id: batch.workflowRunId } });
  assert.equal(branch.parentWorkflowRunId, state.workflowRunId);
  assert.ok(branch.branchPublishedAt);
  const extraBranches = await db.workflowRun.count({ where: { projectId: state.projectId,
    parentWorkflowRunId: batch.workflowRunId } });
  assert.equal(extraBranches, 0, 'Single packaging must not create another branch');
  const root = await db.workflowNodeState.findUniqueOrThrow({ where: { projectId_workflowRunId_nodeId: {
    projectId: state.projectId, workflowRunId: state.workflowRunId, nodeId: 'TEMPLATE_MIX' } } });
  assert.equal(root.contentHash, workflowStateHash(state.baseline), 'Batch altered its source branch');
  const oldTarget = batch.items.find((item) => item.variantId === state.variantIds[0]);
  const newTarget = single.items[0];
  const audioIds = (checkpoint) => [checkpoint.music?.fileObjectId,
    ...Object.values(checkpoint.voices || {}).map((voice) => voice.fileObjectId)].filter(Boolean);
  assert.ok(audioIds(newTarget.checkpoint).every((id) => !audioIds(oldTarget.checkpoint).includes(id)),
    'Repackaging must synthesize fresh audio, not reuse the previous package');
  const sibling = batch.items.find((item) => item.variantId === state.variantIds[1]);
  const siblingArtifacts = await db.workingArtifact.findMany({ where: { projectId: state.projectId,
    workflowRunId: batch.workflowRunId, artifactKey: { in: [
      `timeline-project:${state.templateId}:${sibling.variantId}`, `timeline-package:${state.templateId}:${sibling.variantId}`] } } });
  assert.equal(siblingArtifacts.length, 2);
  assert.ok(siblingArtifacts.every((artifact) => artifact.updatedAt <= single.createdAt), 'Single packaging changed its sibling');
  const snapshot = sibling.snapshot;
  const empty = new Set(snapshot.baselineVariant.intentionallyEmptySlotIds);
  assert.equal(empty.size, 1);
  assert.equal(snapshot.clips.length, 5);
  assert.ok(snapshot.clips.every((clip) => !empty.has(clip.slotId)));
  assert.ok(sibling.checkpoint.script.every((line) => !empty.has(line.slotId)));
  for (const failed of state.previousRuns || []) if (failed.status === 'FAILED') {
    const run = await db.effectPackagingRun.findUniqueOrThrow({ where: { id: failed.id } });
    const failedBranch = await db.workflowRun.findUniqueOrThrow({ where: { id: run.workflowRunId } });
    assert.equal(failedBranch.branchPublishedAt, null, 'All-failed task published a branch');
  }
  console.log(JSON.stringify({ verified: true, batchFilms: 2, singleFilms: 1, singleRunId: single.id,
    sameBranch: true, siblingUnchanged: true, sourceBranchUnchanged: true,
    freshSingleAudioFiles: audioIds(newTarget.checkpoint).length, emptySlotSkipped: true }));
}
async function prepare() {
  assert.ok(!state.projectId, 'An isolated fixture already exists; do not recreate it');
  const sourceProjectId = process.env.PACKAGING_SOURCE_PROJECT_ID;
  const sourceRunId = process.env.PACKAGING_SOURCE_RUN_ID;
  const sourceTemplateId = process.env.PACKAGING_SOURCE_TEMPLATE_ID;
  assert.ok([sourceProjectId, sourceRunId, sourceTemplateId].every((id) => /^[a-f0-9-]{36}$/.test(id || '')));
  const sourceNode = await db.workflowNodeState.findUniqueOrThrow({ where: {
    projectId_workflowRunId_nodeId: { projectId: sourceProjectId, workflowRunId: sourceRunId, nodeId: 'TEMPLATE_MIX' } } });
  const sourceEntry = sourceNode.state.templates.find((entry) => entry.id === sourceTemplateId);
  assert.ok(sourceEntry?.workspace.variants.length >= 2);
  const variants = structuredClone(sourceEntry.workspace.variants.slice(0, 2));
  const materialIds = new Set(variants.flatMap((variant) => Object.values(variant.bindings).filter(Boolean)));
  const all = await db.workingArtifact.findMany({ where: { projectId: sourceProjectId },
    include: { files: { include: { fileObject: true } }, dependencies: true } });
  const byId = new Map(all.map((artifact) => [artifact.id, artifact]));
  const selected = new Map();
  function visit(id) {
    if (selected.has(id)) return;
    const artifact = byId.get(id);
    assert.ok(artifact, 'Missing real source artifact');
    selected.set(id, artifact);
    for (const dependency of artifact.dependencies) if (dependency.sourceArtifactId) visit(dependency.sourceArtifactId);
  }
  for (const id of materialIds) visit(id);
  const videoFiles = new Set([...materialIds].map((id) => byId.get(id).payload.fileObjectId));
  for (const artifact of all.filter((a) => a.workflowRunId === sourceRunId && a.artifactKey.startsWith('render-batch:'))) {
    const clips = artifact.payload?.clips?.filter((clip) => videoFiles.has(clip.fileObjectId));
    if (clips?.length) { visit(artifact.id); selected.set(artifact.id, { ...artifact,
      payload: { ...artifact.payload, clips, removedSources: [] } }); }
  }
  // Only confirmed upstream facts/media are copied, not historical packages or deliveries.
  assert.ok([...selected.values()].every((a) => ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION', 'SEGMENT_RENDER'].includes(a.nodeId)));
  const fileIds = new Set([...selected.values()].flatMap((a) => [
    ...a.files.map((file) => file.fileObjectId), ...(a.payload?.fileObjectId ? [a.payload.fileObjectId] : [])]));
  const files = await db.fileObject.findMany({ where: { projectId: sourceProjectId, id: { in: [...fileIds] } } });
  assert.equal(files.length, fileIds.size);
  const project = await request('/projects', 'POST', { name: `包装真实验收-20261011-${randomUUID().slice(0, 8)}`,
    description: '隔离付费验收，复制确认事实和媒体；不修改业务项目', workflow: 'EFFECT', space: 'EFFECT' });
  const runId = randomUUID(), templateId = randomUUID();
  state = { projectId: project.id, workflowRunId: runId, templateId, sourceProjectId, sourceRunId,
    sourceNodeHash: sourceNode.contentHash, sourceRevision: sourceNode.revision, fileCount: files.length };
  await persist();
  const ids = new Map([[sourceProjectId, project.id], [sourceRunId, runId], [sourceTemplateId, templateId],
    ...[...selected.keys(), ...fileIds, ...variants.map((variant) => variant.id)].map((id) => [id, randomUUID()])]);
  const storage = process.env.STORAGE_DRIVER === 'tos'
    ? new TosStorageAdapter(config, createTosClient(config)) : new LocalStorageAdapter(config);
  const storageKeys = new Map();
  for (const file of files) {
    const response = await fetch(`${base}/projects/${sourceProjectId}/file-objects/${file.id}/content`,
      { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok && response.body, 'Source file unavailable');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, file.sizeBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    const stored = await storage.put({ projectId: project.id, stream: Readable.from(bytes), sizeBytes: bytes.length,
      contentType: file.mimeType, keyContext: { projectName: project.name, workflow: 'EFFECT', lifecycle: 'staging',
        category: 'packaging-paid-test', originalFileName: file.originalFileName } });
    assert.notEqual(stored.key, file.storageKey);
    storageKeys.set(file.storageKey, stored.key);
  }
  const remap = (value) => {
    if (typeof value === 'string') {
      if (ids.has(value)) return ids.get(value);
      if (storageKeys.has(value)) return storageKeys.get(value);
      let result = value;
      for (const [before, after] of ids) result = result.replaceAll(before, after);
      return result;
    }
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [remap(key), remap(child)]));
    return value;
  };
  const entry = remap(structuredClone(sourceEntry));
  entry.workspace.variants = remap(variants).map((variant, index) => ({ ...variant, name: `验收成片 ${index + 1}`,
    bgm: null, voice: null, detachedAudios: [], audioLanes: {},
    captions: [{ id: `manual-${index}`, start: 0, end: 1, text: '包装前人工字幕', manual: true }] }));
  // The second film deliberately has an empty middle slot, retaining its full duration.
  const second = entry.workspace.variants[1], emptySlot = second.slots[2].id;
  second.preservedTimelineEnd = second.slots.reduce((sum, slot) => sum + slot.duration, 0);
  second.intentionallyEmptySlotIds = [...new Set([...(second.intentionallyEmptySlotIds || []), emptySlot])];
  for (const field of ['bindings', 'bindingRevisions', 'bindingSources', 'bindingMetadata', 'offsets']) delete second[field]?.[emptySlot];
  entry.filledTemplateHash = templateConfigurationHash(entry.workspace.template);
  for (const variant of entry.workspace.variants) variant.appliedTemplateHash = entry.filledTemplateHash;
  entry.needsAiFill = false; entry.aiFillLocked = false; entry.packagingLocked = false;
  const draft = { schemaVersion: 1, templates: [entry], activeTemplateId: templateId };
  await db.$transaction(async (tx) => {
    await tx.workflowRun.create({ data: { id: runId, projectId: project.id, workflow: 'EFFECT', workflowSpace: 'EFFECT',
      activeKey: 'ACTIVE', status: 'ACTIVE', currentNodeId: 'TEMPLATE_MIX' } });
    await tx.effectImportWorkspace.create({ data: { projectId: project.id, workflowRunId: runId } });
    for (const file of files) await tx.fileObject.create({ data: { ...omit(file, ['createdAt', 'updatedAt', 'orphanedAt']),
      id: ids.get(file.id), projectId: project.id, workflowRunId: runId, storageKey: storageKeys.get(file.storageKey), status: 'AVAILABLE' } });
    for (const artifact of selected.values()) await tx.workingArtifact.create({ data: {
      ...remap(omit(artifact, ['files', 'dependencies', 'createdAt', 'updatedAt'])), workflowRunId: runId, projectId: project.id,
      // Provenance is the copied confirmed fixture, not a cross-project writable source.
      metadata: { ...remap(artifact.metadata || {}), branchSourceOwner: true } } });
    for (const artifact of selected.values()) {
      for (const dependency of artifact.dependencies) await tx.workingArtifactDependency.create({ data: {
        ...remap(omit(dependency, ['id', 'createdAt'])), projectId: project.id, workflowRunId: runId } });
      for (const file of artifact.files) await tx.workingArtifactFile.create({ data: {
        ...remap(omit(file, ['id', 'createdAt', 'fileObject'])), projectId: project.id, workflowRunId: runId } });
    }
    await tx.workflowNodeState.create({ data: { projectId: project.id, workflowRunId: runId, nodeId: 'TEMPLATE_MIX',
      state: draft, contentHash: workflowStateHash(draft), schemaVersion: 1 } });
  }, { timeout: 120000 });
  state.variantIds = entry.workspace.variants.map((variant) => variant.id);
  state.baseline = draft;
  await persist();
  console.log(JSON.stringify({ prepared: true, projectId: project.id, workflowRunId: runId,
    templateId, films: 2, emptyMiddleSlot: true, files: files.length, artifacts: selected.size }));
}
try {
  if (process.argv.includes('--prepare')) await prepare();
  else {
    assert.ok(state.projectId && state.variantIds, 'Prepare the isolated fixture first');
    const root = `/projects/${state.projectId}/workflows/effect/template-mix`;
    if (process.argv.includes('--verify')) await verifyResults();
    else if (process.argv.includes('--batch') || process.argv.includes('--single')) {
      const single = process.argv.includes('--single');
      const workflowRunId = single ? state.batchWorkflowRunId : state.workflowRunId;
      const workspace = await request(`${root}?workflowRunId=${workflowRunId}`);
      const key = single ? 'single' : 'batch';
      if (state[`${key}RunId`] && process.argv.includes('--new')) {
        const previous = await request(`${root}/packaging-runs/${state[`${key}RunId`]}`);
        assert.ok(['COMPLETED', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(previous.status), 'Previous probe is still active');
        state.previousRuns = [...(state.previousRuns || []), { kind: key, id: previous.id, status: previous.status }];
        delete state[`${key}RunId`]; delete state[`${key}Request`];
      }
      assert.ok(!state[`${key}RunId`], 'Do not accidentally repeat a paid probe; --new explicitly starts a fresh terminal rerun');
      state[`${key}Request`] ||= { workflowRunId, expectedRevision: workspace.draftRevision,
        idempotencyKey: randomUUID(), operation: single ? 'SINGLE_PACKAGE' : 'BATCH_PACKAGE',
        ...(single ? { variantId: state.variantIds[0] } : {}) };
      await persist();
      const run = await request(`${root}/templates/${state.templateId}/packaging-runs`, 'POST', state[`${key}Request`]);
      state[`${key}RunId`] = run.id;
      if (!single) state.batchWorkflowRunId = run.workflowRunId;
      await persist();
      // A duplicate HTTP confirmation must return the same task, never another charge.
      const duplicate = await request(`${root}/templates/${state.templateId}/packaging-runs`, 'POST', state[`${key}Request`]);
      assert.equal(duplicate.id, run.id);
      console.log(JSON.stringify({ started: key, id: run.id, workflowRunId: run.workflowRunId, operation: run.operation, items: run.items.length, duplicateIdempotent: true }));
    } else {
      for (const key of ['batch', 'single']) if (state[`${key}RunId`]) {
        const run = await request(`${root}/packaging-runs/${state[`${key}RunId`]}`);
        const branch = await db.workflowRun.findUniqueOrThrow({ where: { id: run.workflowRunId } });
        console.log(JSON.stringify({ kind: key, id: run.id, status: run.status, branchPublished: Boolean(branch.branchPublishedAt),
          counts: run.counts, items: run.items.map((item) => ({ id: item.id, status: item.status, stage: item.stage,
            error: item.errorMessage, retry: item.checkpoint?.recovery, voices: Object.keys(item.checkpoint?.voices || {}).length,
            captions: item.checkpoint?.captions?.length || 0, music: Boolean(item.checkpoint?.music) })) }));
      }
    }
    const source = await db.workflowNodeState.findUniqueOrThrow({ where: { projectId_workflowRunId_nodeId: {
      projectId: state.sourceProjectId, workflowRunId: state.sourceRunId, nodeId: 'TEMPLATE_MIX' } } });
    assert.equal(source.contentHash, state.sourceNodeHash, 'Source business project changed');
    assert.equal(source.revision, state.sourceRevision, 'Source business project revision changed');
  }
} finally { await db.$disconnect(); }
