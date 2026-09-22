import { describe, expect, it, vi } from 'vitest';
import type {
  EffectTemplateMixVariant,
  FinalOutputSnapshot,
  PackagingCheckpoint,
  PackagingSnapshot,
} from '@ai-marketing/contracts';
import type { PrismaService } from '../../../database/prisma.service';
import type { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import { visualHash } from '../template-mix/effect-packaging.domain';
import { EffectFinalOutputService } from './effect-final-output.service';

function harness(count = 1) {
  const variants = Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `v${i}`,
        name: `成片${i}`,
        slots: [],
        bindings: {},
        bindingRevisions: {},
        offsets: {},
      }) as unknown as EffectTemplateMixVariant,
  );
  const sources = [
    {
      id: 'source',
      revision: 1,
      contentHash: 'hash',
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
    },
  ];
  const rows = variants.map((v) => ({
    id: `item-${v.id}`,
    variantId: v.id,
    name: v.name,
    status: 'COMPLETED',
    sourceTimelineHash: visualHash(v),
    snapshot: {
      variant: v,
      sourceTimelineHash: visualHash(v),
      duration: 10,
      clips: [{ fileObjectId: 'video' }],
      facts: [{ id: 'f', text: '确认事实' }],
      dependencies: [
        {
          artifactId: 'source',
          artifactKey: 'source',
          nodeId: 'SOURCE',
          revision: 1,
          contentHash: 'hash',
        },
      ],
    } as PackagingSnapshot,
    checkpoint: {
      vision: [{ start: 0, end: 10, description: '画面' }],
      script: [{ id: 'line', start: 0, end: 4, text: '商品', factIds: ['f'] }],
      voices: { line: { fileObjectId: 'voice', start: 0, duration: 2, volume: 1 } },
      music: { fileObjectId: 'music', start: 0, duration: 10, volume: 0.12 },
      captions: [{ id: 'line', start: 0, end: 2, text: '商品' }],
    },
  }));
  const state = { revision: 1, state: { templates: [{ id: 't', workspace: { variants } }] } };
  const files = ['video', 'voice', 'music'].map((id) => ({
    id,
    originalFileName: id,
    mimeType: 'audio/wav',
    sha256: id,
  }));
  const outputRun = {
    id: 'out',
    projectId: 'p',
    templateId: 't',
    workflowRunId: 'w',
    status: 'QUEUED',
    createdAt: new Date(),
    items: [] as unknown[],
  };
  const db = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    workflowNodeState: { findUnique: vi.fn().mockResolvedValue(state) },
    workingArtifact: { findMany: vi.fn().mockResolvedValue(sources) },
    fileObject: { findMany: vi.fn().mockResolvedValue(files), count: vi.fn().mockResolvedValue(3) },
    effectPackagingRun: { count: vi.fn().mockResolvedValue(0) },
    effectPackagingItem: { findMany: vi.fn().mockResolvedValue(rows) },
    effectFinalOutputRun: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(outputRun),
      create: vi.fn().mockImplementation(({ data }) => {
        outputRun.items = data.items.create;
        return { id: 'out' };
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    effectFinalOutputItem: { updateMany: vi.fn() },
    jobOutbox: { upsert: vi.fn() },
    workflowRun: { updateMany: vi.fn() },
  };
  const inputs = variants.map((v) => ({ artifactKey: `timeline-project:t:${v.id}`, input: {} }));
  const mix = {
    prepareValidation: vi.fn().mockResolvedValue({ variants, inputs }),
    workspace: vi.fn().mockResolvedValue({ materials: [{ fileObjectId: 'video', ratio: '3:4' }] }),
  };
  const working = {
    commitValidatedArtifactsInTransaction: vi
      .fn()
      .mockImplementation(async (_tx, _p, _w, _n, list) =>
        list.map((i: { artifactKey: string }) => ({
          artifactKey: i.artifactKey,
          record: {
            id: i.artifactKey,
            artifactKey: i.artifactKey,
            nodeId: 'TEMPLATE_MIX',
            revision: 2,
            contentHash: 'confirmed-hash',
          },
        })),
      ),
  };
  const service = new EffectFinalOutputService(
    { ...db, $transaction: (fn: (tx: typeof db) => unknown) => fn(db) } as unknown as PrismaService,
    mix as unknown as EffectTemplateMixService,
    working as unknown as WorkflowWorkingRepository,
    {} as StoragePort,
  );
  return { db, service, working, rows, state, sources, mix, outputRun };
}
const request = { workflowRunId: 'w', expectedRevision: 1, idempotencyKey: 'key' };

describe('atomic full packaging completion', () => {
  it.each([1, 10, 100])(
    'commits all %i visuals and packages with one output/outbox',
    async (count) => {
      const { service, db, working, outputRun } = harness(count);
      await service.complete('p', 't', request);
      expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalledTimes(count + 1);
      expect(db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
      expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
      expect(outputRun.items).toHaveLength(count);
      const snapshot = (outputRun.items[0] as { snapshot: FinalOutputSnapshot }).snapshot;
      expect(snapshot.dependencies).toContainEqual(
        expect.objectContaining({ artifactId: 'timeline-project:t:v0', revision: 2 }),
      );
      expect(snapshot.dependencies).toContainEqual(
        expect.objectContaining({ artifactId: 'timeline-package:t:v0', revision: 2 }),
      );
    },
  );
  it.each(['FAILED', 'CANCELLED', 'RUNNING', 'QUEUED'])(
    'does not partially commit when even the last item is %s',
    async (status) => {
      const { service, rows, working, db } = harness(100);
      rows[99]!.status = status;
      await expect(service.complete('p', 't', request)).rejects.toThrow('全部成功');
      expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
    },
  );
  it('refuses changed draft, stale source, missing files before any commit', async () => {
    const { service, state, sources, db, working } = harness();
    state.revision = 2;
    await expect(service.complete('p', 't', request)).rejects.toThrow('草稿');
    state.revision = 1;
    sources[0]!.revision = 2;
    await expect(service.complete('p', 't', request)).rejects.toThrow('上游');
    sources[0]!.revision = 1;
    db.fileObject.findMany.mockResolvedValue([]);
    await expect(service.complete('p', 't', request)).rejects.toThrow('文件');
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
  });
  it('rejects unsupported fact IDs without adding AI review', async () => {
    const { service, rows, working } = harness();
    rows[0]!.checkpoint.script[0]!.factIds = ['invented'];
    await expect(service.complete('p', 't', request)).rejects.toThrow();
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
  });
  it('reuses an identical confirmed input even with a new button key', async () => {
    const { service, db, working } = harness();
    db.effectFinalOutputRun.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'out' });
    await service.complete('p', 't', request);
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('accepts editor-edited audio and renders it as a distinct output run', async () => {
    const canonical = harness();
    await canonical.service.complete('p', 't', request);
    const baseline = canonical.db.effectFinalOutputRun.create.mock.calls[0]![0].data.inputHash;

    const edited = harness();
    const checkpoint = edited.rows[0]!.checkpoint as PackagingCheckpoint;
    checkpoint.voices!['line'] = {
      fileObjectId: 'voice',
      start: 3,
      duration: 1.5,
      volume: 0.4,
      offset: 0.5,
    };
    checkpoint.music = { fileObjectId: 'music', start: 1, duration: 6, volume: 0.2, offset: 0.5 };
    checkpoint.captions = [{ id: 'line', start: 3.2, end: 4.7, text: '商品' }];
    await edited.service.complete('p', 't', request);
    expect(edited.db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
    const created = edited.db.effectFinalOutputRun.create.mock.calls[0]![0].data;
    expect(created.inputHash).not.toBe(baseline);
    const item = created.items.create[0] as { snapshot: FinalOutputSnapshot };
    expect(item.snapshot.packaging.voices!['line']).toMatchObject({ start: 3, offset: 0.5 });
    expect(item.snapshot.packaging.captions).toEqual([
      { id: 'line', start: 3.2, end: 4.7, text: '商品' },
    ]);
  });
  it('rejects reused idempotency keys for different requests', async () => {
    const { service, db } = harness();
    db.effectFinalOutputRun.findUnique.mockResolvedValue({ id: 'out', requestHash: 'other' });
    await expect(service.complete('p', 't', request)).rejects.toThrow('幂等');
  });
  it('old attempt tokens cannot renew or write progress', async () => {
    const { service, db } = harness();
    db.effectFinalOutputRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.progress('p', 'out', 'old', 'item', 0, '失败')).rejects.toThrow('租约');
    expect(db.effectFinalOutputItem.updateMany).not.toHaveBeenCalled();
  });
  it('cancels only unfinished items under the scoped run fence', async () => {
    const { service, db } = harness();
    await service.cancel('p', 'out');
    expect(db.effectFinalOutputItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p', runId: 'out', status: { in: ['QUEUED', 'RUNNING'] } },
      }),
    );
  });
});
