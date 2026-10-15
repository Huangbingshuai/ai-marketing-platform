import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../../../database/prisma.service';
import type { PackagingSnapshot } from '@ai-marketing/contracts';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { templateConfigurationHash } from './template-mix-lifecycle';

const testTemplate = { name: '模板', editVersion: 1, slots: [] };
const testDraft = {
  schemaVersion: 1,
  activeTemplateId: 't',
  templates: [{ id: 't', workspace: { editVersion: 1, template: testTemplate, variants: [] } }],
};

function harness() {
  const db = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    effectPackagingRun: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'run' }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    effectPackagingItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workingArtifact: { findMany: vi.fn().mockResolvedValue([]) },
    workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'w' }) },
    effectTemplateMixAiRun: { count: vi.fn().mockResolvedValue(0) },
    effectFinalOutputItem: { findMany: vi.fn().mockResolvedValue([]) },
    workflowNodeState: {
      findUnique: vi.fn().mockResolvedValue({ id: 'state', revision: 1, state: testDraft }),
      update: vi.fn(),
    },
    jobOutbox: { upsert: vi.fn() },
  };
  const repo = new EffectPackagingRepository({
    ...db,
    $transaction: (fn: (tx: typeof db) => unknown) => fn(db),
  } as unknown as PrismaService);
  return { db, repo };
}
describe('packaging lightweight read scope', () => {
  it('requires the exact project and effect workflow Run', async () => {
    const { db, repo } = harness();
    await repo.readRunScope('p', 'w');
    expect(db.workflowRun.findFirst).toHaveBeenCalledWith({
      where: { id: 'w', projectId: 'p', workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      select: { id: true },
    });
  });
  it('loads only exact legacy render identities, without resolving newer branch heads', async () => {
    const { db, repo } = harness();
    db.workingArtifact.findMany.mockResolvedValue([
      { id: 'old', name: '煎制 视频片段', payload: { renderCode: 'R-03', prompt: 'private' } },
      { id: 'import', name: '导入素材', payload: null },
    ] as never);
    await expect(repo.materialLabels('p', ['old', 'import'])).resolves.toEqual([
      { id: 'old', code: 'R-03', name: '煎制' }, { id: 'import', code: '导入素材', name: '导入素材' },
    ]);
    expect(db.workingArtifact.findMany).toHaveBeenCalledWith({
      where: { projectId: 'p', id: { in: ['old', 'import'] }, nodeId: 'SEGMENT_RENDER',
        artifactKey: { startsWith: 'render-clip:' } },
      select: { id: true, name: true, payload: true },
    });
    expect(db.workflowNodeState.findUnique).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('never expands an empty source selection to the whole project', async () => {
    const { db, repo } = harness();
    await expect(repo.materialLabels('p', [])).resolves.toEqual([]);
    expect(db.workingArtifact.findMany).not.toHaveBeenCalled();
  });
});
describe('packaging lease and durable task repository', () => {
  it.each(['none', 'source', 'target'] as const)('keeps independent source and target fences (%s changed)', async (changed) => {
    const { db, repo } = harness();
    db.workflowNodeState.findUnique
      .mockResolvedValueOnce({ id: 'source', revision: changed === 'source' ? 34 : 33, state: testDraft })
      .mockResolvedValueOnce({ id: 'target', revision: changed === 'target' ? 35 : 34, state: testDraft });
    const task = repo.create({ projectId: 'p', workflowRunId: 'child', sourceWorkflowRunId: 'w', templateId: 't',
      idempotencyKey: 'fenced-create', requestHash: 'hash', expectedDraftRevision: 34, expectedSourceDraftRevision: 33,
      expectedTemplateHash: templateConfigurationHash(testTemplate), checkpoints: [{}],
      snapshots: [{ operation: 'BATCH_PACKAGE', variant: { id: 'v' } } as PackagingSnapshot],
    });
    if (changed === 'none') {
      await expect(task).resolves.toBe('run');
      expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    } else {
      await expect(task).rejects.toThrow(changed === 'source' ? '原工程已改变' : '混剪草稿已变化');
      expect(db.effectPackagingRun.create).not.toHaveBeenCalled();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
    }
  });
  it('rejects an overlapping child task under the source node lock', async () => {
    const { db, repo } = harness();
    db.effectPackagingItem.findMany.mockResolvedValue([{ variantId: 'v', run: { templateId: 't' },
      snapshot: { operation: 'SINGLE_PACKAGE' } }] as never);
    await expect(repo.create({ projectId: 'p', workflowRunId: 'child', sourceWorkflowRunId: 'w', templateId: 't',
      idempotencyKey: 'new', requestHash: 'hash', expectedDraftRevision: 1,
      expectedTemplateHash: templateConfigurationHash(testTemplate), checkpoints: [{}],
      snapshots: [{ operation: 'BATCH_PACKAGE', variant: { id: 'v' } } as PackagingSnapshot],
    })).rejects.toThrow('已有包装任务');
    expect(db.effectPackagingRun.create).not.toHaveBeenCalled();
  });
  it.each(['FAILED', 'CANCELLED'])('does not reopen a %s film on a late checkpoint', async (status) => {
    const { db, repo } = harness();
    db.effectPackagingItem.findFirst.mockResolvedValue({ id: 'i', status, snapshot: { operation: 'SINGLE_PACKAGE' } });
    await expect(repo.checkpoint('p', 'r', 'token', 'i', 'VOICE', {})).resolves.toEqual({ accepted: true });
    expect(db.effectPackagingItem.update).not.toHaveBeenCalled();
  });
  it('loads one worker item scoped by project and run without hydrating the batch', async () => {
    const { db, repo } = harness();
    db.effectPackagingItem.findFirst.mockResolvedValue({ id: 'i' });
    expect(await repo.getItem('p', 'r', 'i')).toEqual({ id: 'i' });
    expect(db.effectPackagingItem.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'p', runId: 'r', id: 'i' },
      include: { run: { select: { workflowRunId: true, templateId: true } } },
    });
    expect(db.effectPackagingRun.findFirst).not.toHaveBeenCalled();
  });
  it('reads required revisions from the active run source graph, including inherited sources', async () => {
    const { db, repo } = harness();
    const source = { id: 'a', revision: 3, freshness: 'CURRENT', availability: 'AVAILABLE' };
    const projection = vi.spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts')
      .mockResolvedValue([source, { ...source, id: 'unconsumed' }] as never);
    try {
      expect(await repo.sourceArtifacts('p', 'w', ['a'])).toEqual([source]);
      expect(db.workflowRun.findFirst).toHaveBeenCalledWith({
        where: { projectId: 'p', id: 'w', status: { in: ['ACTIVE', 'PAUSED'] } }, select: { id: true },
      });
      expect(projection).toHaveBeenCalledWith('p', { workflowRunId: 'w' }, { upstreamOnly: true });
      expect(await repo.sourceArtifacts('p', 'w', [])).toEqual([]);
      expect(projection).toHaveBeenCalledOnce();
      db.workflowRun.findFirst.mockResolvedValue(null);
      expect(await repo.sourceArtifacts('other-project', 'w', ['a'])).toEqual([]);
      expect(projection).toHaveBeenCalledOnce();
      expect(db.workingArtifact.findMany).not.toHaveBeenCalled();
    } finally {
      projection.mockRestore();
    }
  });
  it('shares only in-flight source reads, not resolved revisions or another project/Run', async () => {
    const { repo } = harness();
    let release!: (value: never) => void;
    const projection = vi.spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts')
      .mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const source = { id: 'a', revision: 1, freshness: 'CURRENT', availability: 'AVAILABLE' };
    try {
      const reads = [repo.sourceArtifacts('p', 'w', ['a']), repo.sourceArtifacts('p', 'w', ['a'])];
      await vi.waitFor(() => expect(projection).toHaveBeenCalledTimes(1));
      release([source] as never);
      expect(await Promise.all(reads)).toEqual([[source], [source]]);
      projection.mockResolvedValue([{ ...source, revision: 2 }] as never);
      expect(await repo.sourceArtifacts('p', 'w', ['a'])).toEqual([{ ...source, revision: 2 }]);
      await repo.sourceArtifacts('other', 'w', ['a']);
      await repo.sourceArtifacts('p', 'other', ['a']);
      expect(projection).toHaveBeenCalledTimes(4);
    } finally { projection.mockRestore(); }
  });
  it('falls back to the full consumed dependency closure for a legacy non-head source ID', async () => {
    const { repo } = harness();
    const historical = { id: 'old-exact-id', revision: 1, freshness: 'CURRENT', availability: 'AVAILABLE' };
    const projection = vi.spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts')
      .mockResolvedValueOnce([]).mockResolvedValueOnce([historical] as never);
    try {
      expect(await repo.sourceArtifacts('p', 'w', ['old-exact-id'])).toEqual([historical]);
      expect(projection).toHaveBeenLastCalledWith('p', { workflowRunId: 'w' });
    } finally { projection.mockRestore(); }
  });
  it('uses the same verified render projection for creation and worker execution without masking real staleness', async () => {
    const { repo } = harness();
    const source = { id: 'clip', nodeId: 'SEGMENT_RENDER', artifactKey: 'render-clip:c',
      revision: 1, freshness: 'STALE', availability: 'AVAILABLE',
      metadata: { promptSourcePending: true }, payload: { promptText: '冻结正文',
        adoptedPrompt: { promptContentHash: createHash('sha256').update('冻结正文').digest('hex') } } };
    const invalid = { ...source, id: 'invalid', payload: { ...source.payload,
      adoptedPrompt: { promptContentHash: 'mismatch' } } };
    const stale = { ...source, id: 'other-stale', metadata: {} };
    const missing = { ...source, id: 'missing', availability: 'MISSING' };
    const projection = vi.spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts')
      .mockResolvedValue([source, invalid, stale, missing] as never);
    try {
      expect(await repo.sourceArtifacts('p', 'w', ['clip', 'invalid', 'other-stale', 'missing']))
        .toEqual([
          { id: 'clip', revision: 1, freshness: 'CURRENT', availability: 'AVAILABLE' },
          { id: 'invalid', revision: 1, freshness: 'STALE', availability: 'AVAILABLE' },
          { id: 'other-stale', revision: 1, freshness: 'STALE', availability: 'AVAILABLE' },
          { id: 'missing', revision: 1, freshness: 'STALE', availability: 'MISSING' },
        ]);
      expect(source.freshness).toBe('STALE');
    } finally {
      projection.mockRestore();
    }
  });
  it('inherits composite run/project relation fields for nested items', async () => {
    const { db, repo } = harness();
    const snapshot = {
      duration: 32,
      variant: { id: 'variant', name: '成片 01' },
      sourceTimelineHash: 'hash',
      facts: [],
      clips: [],
      dependencies: [],
    } as unknown as PackagingSnapshot;
    await repo.create({
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
      idempotencyKey: 'k',
      requestHash: 'hash',
      snapshots: [snapshot],
      checkpoints: [{}],
      expectedDraftRevision: 1,
      expectedTemplateHash: templateConfigurationHash(testTemplate),
    });
    const data = db.effectPackagingRun.create.mock.calls[0]![0].data;
    expect(data.projectId).toBe('p');
    expect(data.items.create[0]).toMatchObject({ variantId: 'variant', shardIndex: 0 });
    expect(data.items.create[0]).not.toHaveProperty('projectId');
    expect(data.items.create[0]).not.toHaveProperty('runId');
  });
  it('idempotent replay does not enqueue again, changed request is rejected', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.findUnique.mockResolvedValue({ id: 'run', requestHash: 'same' });
    const input = {
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
      idempotencyKey: 'k',
      requestHash: 'same',
      snapshots: [],
      checkpoints: [],
      expectedDraftRevision: 1,
      expectedTemplateHash: templateConfigurationHash(testTemplate),
    };
    expect(await repo.create(input)).toBe('run');
    expect(db.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('pg_advisory_xact_lock')]),
      'p:w:t',
    );
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
    await expect(repo.create({ ...input, requestHash: 'different' })).rejects.toThrow('幂等');
  });
  it('saves source rebindings only into the requested new packaging branch', async () => {
    const { db, repo } = harness();
    const state = structuredClone(testDraft);
    const old = { id: 'variant', name: '成片 01', appliedTemplateVersion: 1, slots: [],
      bindings: { a: 'old' }, bindingRevisions: { a: 1 }, offsets: { a: 5 } };
    state.templates[0]!.workspace.variants = [old] as never;
    db.workflowNodeState.findUnique.mockResolvedValue({ id: 'child-state', revision: 1, state });
    const fresh = { ...old, bindings: { a: 'new' }, bindingRevisions: { a: 2 }, offsets: { a: 0 } };
    const snapshot = { duration: 4, variant: fresh, sourceTimelineHash: 'fresh', facts: [], clips: [], dependencies: [],
      sourceTrimMaterials: [{ slotId: 'a', material: { id: 'new', fileObjectId: 'new-file' } }] } as unknown as PackagingSnapshot;
    await repo.create({ projectId: 'p', workflowRunId: 'child', templateId: 't', idempotencyKey: 'fresh',
      requestHash: 'fresh-request', snapshots: [snapshot], checkpoints: [{}], expectedDraftRevision: 1,
      expectedTemplateHash: templateConfigurationHash(testTemplate) });
    expect(db.workflowNodeState.update).toHaveBeenCalledOnce();
    expect(db.workflowNodeState.update.mock.calls[0]![0]).toMatchObject({ where: { id: 'child-state' },
      data: { revision: { increment: 1 }, state: { templates: [{ workspace: { variants: [fresh], editVersion: 2 } }] } } });
    expect(db.effectPackagingRun.create.mock.calls[0]![0].data.workflowRunId).toBe('child');
    expect(old.bindings.a).toBe('old'); expect(old.offsets.a).toBe(5);
  });
  it('uses the existing queue with an explicit schema-2 discriminator', async () => {
    const { db, repo } = harness();
    await repo.create({
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
      idempotencyKey: 'k',
      requestHash: 'hash',
      snapshots: [],
      checkpoints: [],
      expectedDraftRevision: 1,
      expectedTemplateHash: templateConfigurationHash(testTemplate),
    });
    expect(db.jobOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          routingKey: 'effect.template-mix.requested',
          payload: expect.objectContaining({
            schemaVersion: 2,
            taskType: 'PACKAGING',
            projectId: 'p',
            runId: 'run',
          }),
        }),
      }),
    );
  });
  it('derives the source lock from running tasks rather than permanently rewriting the draft', async () => {
    const { db, repo } = harness();
    await repo.create({
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
      idempotencyKey: 'k',
      requestHash: 'hash',
      snapshots: [],
      checkpoints: [],
      expectedDraftRevision: 1,
      expectedTemplateHash: templateConfigurationHash(testTemplate),
    });
    expect(db.workflowNodeState.update).not.toHaveBeenCalled();
    db.effectPackagingRun.findMany.mockResolvedValue([{ templateId: 't', items: [{ snapshot: {} }] }] as never);
    expect(await repo.sourceLockedTemplateIds('p', 'w')).toEqual(['t']);
    expect(db.effectPackagingRun.findMany).toHaveBeenCalledWith({
      where: { projectId: 'p', status: { in: ['QUEUED', 'RUNNING'] },
        OR: [{ workflowRunId: 'w' },
          { workflowRun: { parentWorkflowRunId: 'w', forkNodeId: 'TEMPLATE_MIX' } }],
      }, select: { templateId: true, items: { select: { snapshot: true } } },
    });
    db.effectPackagingRun.findMany.mockResolvedValue([]);
    expect(await repo.sourceLockedTemplateIds('p', 'w')).toEqual([]);
  });
  it('rejects packaging atomically while any bound variant uses an older template', async () => {
    const { db, repo } = harness();
    const currentHash = templateConfigurationHash(testTemplate);
    db.workflowNodeState.findUnique.mockResolvedValue({
      id: 'state',
      revision: 1,
      state: {
        ...testDraft,
        templates: [
          {
            id: 't',
            filledTemplateHash: currentHash,
            workspace: {
              editVersion: 1,
              template: testTemplate,
              variants: [
                {
                  id: 'v',
                  bindings: { slot: 'asset' },
                  appliedTemplateHash: 'old-template-hash',
                },
              ],
            },
          },
        ],
      },
    });
    await expect(
      repo.create({
        projectId: 'p',
        workflowRunId: 'w',
        templateId: 't',
        idempotencyKey: 'k',
        requestHash: 'hash',
        snapshots: [],
        checkpoints: [],
        expectedDraftRevision: 1,
        expectedTemplateHash: currentHash,
      }),
    ).rejects.toThrow('仍有成片未按当前模板重新智能填充');
    expect(db.effectPackagingRun.create).not.toHaveBeenCalled();
  });
  it('rejects old token and expired lease writes before touching items', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.checkpoint('p', 'r', 'old', 'i', 'READY', {})).rejects.toThrow('租约');
    expect(db.effectPackagingItem.update).not.toHaveBeenCalled();
  });
  it('does not grant a second live lease', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.findFirst.mockResolvedValue({
      status: 'RUNNING',
      leaseExpiresAt: new Date(Date.now() + 90_000),
    });
    expect(await repo.claim('p', 'r')).toEqual({ terminal: true });
    expect(db.effectPackagingRun.update).not.toHaveBeenCalled();
  });
  it('restart recovery requeues expired runs without discarding successful checkpoints', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.findMany.mockResolvedValue([{ id: 'r', projectId: 'p' }]);
    await repo.recoverExpired();
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(db.jobOutbox.upsert.mock.calls[0]![0].update).toMatchObject({
      status: 'PENDING',
      dispatchToken: null,
      publishedAt: null,
    });
    expect(db.effectPackagingItem.updateMany).not.toHaveBeenCalled();
  });
  it('retry re-arms the unique outbox row while retaining successful items and checkpoints', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.findFirst.mockResolvedValue({
      id: 'r',
      workflowRunId: 'w',
      templateId: 't',
      status: 'CANCELLED',
    });
    await repo.retry('p', 'r');
    expect(db.jobOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_jobType_aggregateId: {
            projectId: 'p',
            jobType: 'EFFECT_TEMPLATE_MIX',
            aggregateId: 'r',
          },
        },
        update: expect.objectContaining({
          status: 'PENDING',
          attempts: 0,
          dispatchToken: null,
          publishedAt: null,
          lastError: null,
        }),
      }),
    );
    expect(db.effectPackagingItem.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'p', runId: 'r', status: { not: 'COMPLETED' } },
      data: { status: 'QUEUED', errorMessage: null, completedAt: null },
    });
  });
  it('locks editor audio edits by updatedAt and rejects lost updates', async () => {
    const { db, repo } = harness();
    db.effectPackagingItem.findFirst.mockResolvedValue({ id: 'i', variantId: 'v',
      run: { workflowRunId: 'w', templateId: 't' } });
    db.effectPackagingItem.updateMany.mockResolvedValue({ count: 1 });
    db.effectPackagingItem.findFirstOrThrow.mockResolvedValue({ id: 'i' });
    await repo.updateCheckpoint('p', 'i', { musicTaskId: 'x' }, '2026-01-01T00:00:00.000Z');
    expect(db.effectPackagingItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'i', projectId: 'p', updatedAt: new Date('2026-01-01T00:00:00.000Z') },
      data: { checkpoint: { musicTaskId: 'x' } },
    });
    db.effectPackagingItem.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.updateCheckpoint('p', 'i', {}, '2026-01-01T00:00:00.000Z')).rejects.toThrow(
      '已被修改',
    );
    await expect(repo.updateCheckpoint('p', 'i', {}, 'not-a-date')).rejects.toThrow('已被修改');
    expect(db.effectPackagingItem.findFirstOrThrow).toHaveBeenCalledTimes(1);
  });
  it('rejects edits to updating captions/audio but leaves other projects editable', async () => {
    const { db, repo } = harness();
    db.effectPackagingItem.findFirst.mockResolvedValue({ id: 'i', variantId: 'v',
      run: { workflowRunId: 'w', templateId: 't' } });
    db.effectFinalOutputItem.findMany.mockResolvedValue([{ snapshot: { sourceRefresh: {
      workflowRunId: 'w', templateId: 't', baselineVariant: { id: 'v' },
    } } }]);
    await expect(repo.updateCheckpoint('p', 'i', {}, '2026-01-01T00:00:00.000Z'))
      .rejects.toThrow('局部更新正在进行');
    expect(db.effectPackagingItem.updateMany).not.toHaveBeenCalled();
    db.effectPackagingItem.findFirst.mockResolvedValue({ id: 'i', variantId: 'sibling',
      run: { workflowRunId: 'w', templateId: 't' } });
    db.effectPackagingItem.updateMany.mockResolvedValue({ count: 1 });
    await repo.updateCheckpoint('p', 'i', {}, '2026-01-01T00:00:00.000Z');
    expect(db.effectPackagingItem.updateMany).toHaveBeenCalledOnce();
    expect(db.$queryRaw).toHaveBeenCalled();
  });
  it('keeps parent audio editable during a child repackage while fencing its own active film', async () => {
    const { db, repo } = harness();
    db.effectPackagingItem.findFirst.mockResolvedValue({ id: 'i', variantId: 'v',
      run: { workflowRunId: 'w', templateId: 't' } });
    db.effectPackagingItem.findMany.mockResolvedValue([{ variantId: 'v',
      snapshot: { operation: 'BATCH_PACKAGE' }, run: { workflowRunId: 'child', templateId: 't' } }]);
    db.effectPackagingItem.updateMany.mockResolvedValue({ count: 1 });
    await expect(repo.updateCheckpoint('p', 'i', {}, '2026-01-01T00:00:00.000Z')).resolves.toBeUndefined();
    expect(db.effectPackagingItem.updateMany).toHaveBeenCalledOnce();
    db.effectPackagingItem.findMany.mockResolvedValue([{ variantId: 'v',
      snapshot: { operation: 'BATCH_PACKAGE' }, run: { workflowRunId: 'w', templateId: 't' } }]);
    await expect(repo.updateCheckpoint('p', 'i', {}, '2026-01-01T00:00:00.000Z')).rejects.toThrow('正在包装');
    expect(db.effectPackagingItem.updateMany).toHaveBeenCalledOnce();
  });
  it('cancel invalidates the attempt and only cancels unfinished items', async () => {
    const { db, repo } = harness();
    await repo.cancel('p', 'r');
    expect(db.effectPackagingRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'p', id: 'r' }),
        data: expect.objectContaining({ attemptToken: null, status: 'CANCELLED' }),
      }),
    );
    expect(db.effectPackagingItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p', runId: 'r', status: { in: ['QUEUED', 'RUNNING'] } },
      }),
    );
  });
});
