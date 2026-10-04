import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type {
  EffectTemplateMixVariant,
  FinalOutputSnapshot,
  PackagingCheckpoint,
  PackagingSnapshot,
} from '@ai-marketing/contracts';
import type { PrismaService } from '../../../database/prisma.service';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
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
        slots: [{ id: 's', role: 'PRODUCT', label: '产品', duration: 10, transition: '硬切' }],
        bindings: { s: 'clip' },
        bindingRevisions: { s: 1 },
        offsets: { s: 0 },
      }) as unknown as EffectTemplateMixVariant,
  );
  const sources = [
    {
      id: 'source',
      revision: 1,
      contentHash: 'hash',
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      artifactKey: 'render-clip:source',
      payload: { promptId: 'pr' },
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'pr', sourceRevision: 1 }],
    },
    { id: 'pr', revision: 1, contentHash: 'prompt-hash', freshness: 'CURRENT',
      availability: 'AVAILABLE', artifactKey: 'prompt-batch:pr',
      payload: { items: [{ id: 'pr', content: '已确认原始 Prompt' }] }, dependencies: [] },
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
      clips: [{ slotId: 's', start: 0, duration: 10, fileObjectId: 'video' }],
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
      narrationLayoutVersion: 'SLOT_V1' as const,
      vision: [{ start: 0, end: 10, description: '画面' }],
      script: [{ id: 'line', slotId: 's', start: 0, end: 10, text: '商品', factIds: ['f'] }],
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
    status: 'PENDING_RENDER',
    createdAt: new Date(),
    items: [] as unknown[],
  };
  // The batch the output node is already holding un-exported, if any. `null` means the queue lookup
  // finds nothing and the packaging callback creates a fresh run.
  const pending = {
    current: null as null | {
      id: string;
      projectId: string;
      templateId: string;
      workflowRunId: string;
      status: string;
      createdAt: Date;
      items: { id: string; variantId: string; name: string; snapshot: unknown }[];
    },
  };
  const db = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    workflowNodeState: { findUnique: vi.fn().mockResolvedValue(state) },
    workingArtifact: { findMany: vi.fn().mockResolvedValue(sources), findFirst: vi.fn().mockResolvedValue(null) },
    fileObject: {
      findMany: vi.fn().mockImplementation(({ where }: { where?: { id?: { in?: string[] } } }) =>
        Promise.resolve(where?.id?.in ? files.filter((file) => where.id!.in!.includes(file.id)) : files)),
      count: vi.fn().mockResolvedValue(3),
      create: vi.fn().mockResolvedValue({ id: 'new-file' }),
      delete: vi.fn().mockResolvedValue({ id: 'new-file' }),
      findFirstOrThrow: vi.fn(),
    },
    asset: {
      create: vi.fn().mockResolvedValue({ id: 'asset-created' }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(({ where }) => Promise.resolve({ id: where.id })),
    },
    assetVersion: { create: vi.fn().mockResolvedValue({ id: 'version' }), deleteMany: vi.fn() },
    effectPackagingRun: { count: vi.fn().mockResolvedValue(0) },
    effectPackagingItem: { findMany: vi.fn().mockResolvedValue(rows) },
    effectFinalOutputRun: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      // Only the queue lookup filters on PENDING_RENDER; every other caller names a run by id.
      findFirst: vi.fn().mockImplementation((args: { where?: { status?: unknown } }) =>
        Promise.resolve(args?.where?.status === 'PENDING_RENDER' ? pending.current :
          typeof args?.where?.status === 'object' ? pending.current ?? outputRun : outputRun),
      ),
      findMany: vi.fn().mockResolvedValue([outputRun]),
      create: vi.fn().mockImplementation(({ data }) => {
        outputRun.status = data.status;
        outputRun.items = data.items.create;
        return { id: 'out' };
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockImplementation(({ data }) => Object.assign(outputRun, data)),
    },
    effectFinalOutputItem: {
      create: vi.fn().mockResolvedValue({ id: 'new-item' }),
      delete: vi.fn().mockResolvedValue({ id: 'gone' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve(outputRun.items.find((entry) => (entry as { id: string }).id === where.id))),
      update: vi.fn().mockImplementation(({ where, data }) => {
        const item = outputRun.items.find((entry) => (entry as { id: string }).id === where.id) as Record<string, unknown> | undefined;
        if (item) Object.assign(item, data);
        return data;
      }),
    },
    jobOutbox: { upsert: vi.fn() },
    workflowRun: { updateMany: vi.fn(), findFirst: vi.fn().mockResolvedValue({ id: 'w' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'w', parentWorkflowRunId: null,
        forkNodeId: null, forkTemplateId: null }]) },
    project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'p', name: '项目' }) },
  };
  const inputs = variants.map((v) => ({ artifactKey: `timeline-project:t:${v.id}`, input: {} }));
  const mix = {
    outputSourceWorkspace: vi.fn().mockResolvedValue({ draft: { templates: [{ id: 't', workspace: {
      template: { name: '模板' }, variants } }] }, materials: [{ id: 'clip', artifactId: 'source',
      fileObjectId: 'video', duration: 12, available: true, artifactRevision: 1,
      contentHash: 'hash', ratio: '3:4' }] }),
    prepareValidation: vi.fn().mockResolvedValue({ variants, inputs }),
    workspace: vi.fn().mockResolvedValue({ materials: [{ id: 'clip', artifactId: 'source',
      fileObjectId: 'video', duration: 12, available: true, artifactRevision: 1,
      contentHash: 'hash', ratio: '3:4' }] }),
  };
  const working = {
    listArtifacts: vi.fn().mockResolvedValue(sources),
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
          previousStorageKey: null,
          unchanged: false,
          orphanedFileObjectIds: [],
        })),
      ),
    enqueueCleanup: vi.fn(),
    // No published version to protect, so the first export stays in the Run it was asked for.
    beginEffectNodeEdit: vi.fn().mockResolvedValue({
      runId: 'w',
      parentWorkflowRunId: null,
      productIdMap: {},
      taskIdMap: {},
      created: false,
    }),
    publishEffectNodeEdit: vi.fn(),
  };
  db.workingArtifact.findMany.mockResolvedValue([...sources, ...variants.map((variant) => ({
    id: `timeline-package:t:${variant.id}`, artifactKey: `timeline-package:t:${variant.id}`,
    revision: 2, contentHash: 'confirmed-hash', freshness: 'CURRENT', availability: 'AVAILABLE',
    payload: {}, dependencies: [],
  }))]);
  const storage = {
    put: vi.fn().mockImplementation(async (input: { stream: AsyncIterable<unknown> }) => {
      // The real adapter consumes the upload stream before resolving. Leaving it unread lets a
      // createReadStream open after outputFile() has removed its temporary directory.
      for await (const _chunk of input.stream) {
        /* consume */
      }
      return { key: 'stored/new.mp4', sizeBytes: 64 };
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({ stream: null, contentLength: 12 }),
  };
  // Real transactions roll back on throw; mirror that so "failure keeps the previous output" is
  // actually observable instead of leaving half-applied writes in the fixture.
  const scopedDb = {
    ...db,
    $transaction: async (fn: (tx: typeof db) => unknown) => {
      const before = structuredClone(outputRun);
      try {
        return await fn(db);
      } catch (error) {
        Object.assign(outputRun, before);
        throw error;
      }
    },
  };
  const service = new EffectFinalOutputService(
    scopedDb as unknown as PrismaService,
    mix as unknown as EffectTemplateMixService,
    working as unknown as WorkflowWorkingRepository,
    storage as unknown as StoragePort,
    { getEffectBranchTree: vi.fn().mockResolvedValue({ activeWorkflowRunId: 'w', branches: [{
      workflowRunId: 'w', parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null,
      createdAt: '2026-10-04T00:00:00Z', templates: [{ templateId: 't' }],
    }] }) } as unknown as WorkflowWorkingService,
  );
  return { db, service, working, storage, rows, state, sources, mix, outputRun, pending };
}

/** A real on-disk file so upload()'s MP4 header probe and sha256 pass. */
async function outputFile(): Promise<{ path: string; size: number; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'final-output-unit-'));
  const path = join(directory, 'local.mp4');
  const header = Buffer.alloc(64);
  header.write('ftyp', 4);
  await writeFile(path, header);
  return {
    path,
    size: header.length,
    cleanup: async () => {
      await unlink(path);
      await rmdir(directory);
    },
  };
}
const request = { workflowRunId: 'w', expectedRevision: 1, idempotencyKey: 'key' };

/** workingArtifact rows that satisfy current() for an already-completed batch. */
function currentRows(items: { snapshot: FinalOutputSnapshot }[]) {
  return [
    ...new Map(
      items.flatMap((item) => item.snapshot.dependencies).map((d) => [d.artifactId, d]),
    ).values(),
  ].map((d) => ({
    id: d.artifactId,
    artifactKey: d.artifactKey ?? d.artifactId,
    nodeId: d.nodeId,
    revision: d.revision,
    contentHash: d.contentHash,
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
  }));
}

describe('final output preview covers', () => {
  it('uses the first occupied template slot like the template mix card', async () => {
    const { service, outputRun } = harness();
    const variant = {
      id: 'v0',
      name: '成片0',
      slots: [
        { id: 'first-slot', role: 'HOOK', label: '开场', duration: 3, transition: '硬切' },
        { id: 'earlier-on-timeline', role: 'PRODUCT', label: '产品', duration: 7, transition: '硬切' },
      ],
      bindings: { 'first-slot': 'material-first', 'earlier-on-timeline': 'material-earlier' },
      bindingRevisions: {},
      offsets: {},
    } as unknown as EffectTemplateMixVariant;
    const snapshot = {
      timeline: {
        variant,
        duration: 10,
        clips: [
          {
            slotId: 'earlier-on-timeline',
            materialId: 'material-earlier',
            fileObjectId: 'earlier-cover',
            contentHash: 'earlier-hash',
            start: 0,
            duration: 7,
            offset: 0,
            lane: 0,
            prompt: '',
            transition: '硬切',
            transitionDuration: 0,
          },
          {
            slotId: 'first-slot',
            materialId: 'material-first',
            fileObjectId: 'template-card-cover',
            contentHash: 'template-card-hash',
            start: 7,
            duration: 3,
            offset: 1,
            lane: 0,
            prompt: '',
            transition: '硬切',
            transitionDuration: 0,
          },
        ],
      },
    } as unknown as FinalOutputSnapshot;
    outputRun.items = [{
      id: 'output-item',
      variantId: 'v0',
      name: '成片0',
      status: 'PENDING_RENDER',
      progress: 0,
      errorMessage: null,
      fileObjectId: null,
      assetId: null,
      snapshot,
    }];

    const result = await service.get('p', 'out');

    expect(result.items[0]?.cover).toEqual({
      fileObjectId: 'template-card-cover',
      time: 0.12,
      contentHash: 'template-card-hash',
    });
  });
});

describe('smart-fill pending output', () => {
  const confirmedVisual = (variantId: string) => ({
    id: `timeline-project:t:${variantId}`,
    artifactKey: `timeline-project:t:${variantId}`,
    nodeId: 'TEMPLATE_MIX',
    revision: 2,
    contentHash: `visual-${variantId}`,
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
    dependencies: [],
  });

  it('appends to a delivered batch without modifying old IDs, snapshots, assets or files', async () => {
    const { service, db, sources, outputRun } = harness(2);
    const old = { id: 'old-item', variantId: 'v0', name: '旧成片', status: 'COMPLETED',
      fileObjectId: 'old-video', assetId: 'old-asset', snapshot: { userEdited: true } };
    const frozen = structuredClone(old);
    outputRun.status = 'COMPLETED';
    outputRun.items = [old];
    db.workingArtifact.findMany.mockResolvedValue([...sources, confirmedVisual('v0'), confirmedVisual('v1')]);
    await service.upsertFromSmartFill('p', 'w', 't', ['v1'], true);
    expect(old).toEqual(frozen);
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.delete).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      runId: 'out', variantId: 'v1', snapshot: expect.objectContaining({ appendOnly: true, appendPackagingRequired: true }),
    }) }));
    db.effectFinalOutputItem.findMany.mockResolvedValue([{ variantId: 'v1' }] as never);
    await service.upsertFromSmartFill('p', 'w', 't', ['v1'], true);
    expect(db.effectFinalOutputItem.create).toHaveBeenCalledOnce();
  });

  it('upgrades only the added output entry and commits only its timeline/package', async () => {
    const { service, db, pending, working } = harness(2);
    pending.current = { id: 'out', projectId: 'p', workflowRunId: 'w', templateId: 't',
      status: 'PENDING_RENDER', createdAt: new Date(), items: [
        { id: 'old-item', variantId: 'v0', name: '旧成片', snapshot: { preserve: true } },
        { id: 'new-item', variantId: 'v1', name: '新成片', snapshot: {} },
      ] };
    await service.upsertFromPackaging('p', 'w', 't', { publish: false, onlyVariantIds: ['v1'] });
    expect(db.effectFinalOutputItem.update.mock.calls.map(([arg]) => arg.where.id)).toEqual(['new-item']);
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    const committedKeys = working.commitValidatedArtifactsInTransaction.mock.calls.flatMap((call) =>
      call[4].map((input: { artifactKey: string }) => input.artifactKey));
    expect(committedKeys).toContain('timeline-project:t:v1');
    expect(committedKeys).toContain('timeline-package:t:v1');
    expect(committedKeys).not.toContain('timeline-project:t:v0');
    expect(committedKeys).not.toContain('timeline-package:t:v0');
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
  });

  it.each([false, true])('exports only appended films without changing delivered entries or opening a branch (packaged=%s)', async (packaged) => {
    const { service, db, outputRun, working } = harness(2);
    const old = { id: 'old-item', variantId: 'v0', status: 'COMPLETED', fileObjectId: 'old-file', assetId: 'old-asset', snapshot: { manualEdit: true } };
    const added = { id: 'new-item', variantId: 'v1', status: 'PENDING_RENDER', snapshot: { appendOnly: true, appendPackagingRequired: packaged } };
    const frozen = structuredClone(old);
    outputRun.items = [old, added];
    const internal = service as unknown as {
      startAppendedFilms: (projectId: string, id: string, settings: { resolution: '720p'; frameRate: 30 }) => Promise<void>;
      packagingByVariant: () => Promise<Map<string, unknown>>;
      rewriteFilm: (...args: unknown[]) => Promise<void>;
      current: (...args: unknown[]) => Promise<void>;
      enqueue: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(internal, 'packagingByVariant').mockResolvedValue(packaged ? new Map([['v1', {}]]) : new Map());
    const rewrite = vi.spyOn(internal, 'rewriteFilm').mockResolvedValue(undefined);
    vi.spyOn(internal, 'current').mockResolvedValue(undefined);
    const enqueue = vi.spyOn(internal, 'enqueue').mockResolvedValue(undefined);
    await internal.startAppendedFilms('p', 'out', { resolution: '720p', frameRate: 30 });
    expect(rewrite).toHaveBeenCalledOnce();
    expect(rewrite.mock.calls[0]?.[2]).toBe(added);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(outputRun.status).toBe('QUEUED');
    expect(old).toEqual(frozen);
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('blocks premature encoding when the appended film requires packaging', async () => {
    const { service, outputRun, working } = harness();
    outputRun.items = [{ id: 'new', variantId: 'v0', status: 'PENDING_RENDER', snapshot: { appendOnly: true, appendPackagingRequired: true } }];
    const internal = service as unknown as {
      startAppendedFilms: (projectId: string, id: string, settings: { resolution: '720p'; frameRate: 30 }) => Promise<void>;
      packagingByVariant: () => Promise<Map<string, unknown>>;
      rewriteFilm: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(internal, 'packagingByVariant').mockResolvedValue(new Map());
    const rewrite = vi.spyOn(internal, 'rewriteFilm').mockResolvedValue(undefined);
    await expect(internal.startAppendedFilms('p', 'out', { resolution: '720p', frameRate: 30 })).rejects.toThrow('新增包装尚未完成');
    expect(rewrite).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('queues confirmed picture-only timelines without a paid render or package artifact', async () => {
    const { service, db, sources, outputRun, working } = harness(2);
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources, confirmedVisual('v0'), confirmedVisual('v1'),
    ]);

    await service.upsertFromSmartFill('p', 'w', 't');

    expect(outputRun.status).toBe('PENDING_RENDER');
    expect(outputRun.items).toHaveLength(2);
    for (const item of outputRun.items as { snapshot: FinalOutputSnapshot }[]) {
      expect(item.snapshot).toMatchObject({
        unpackaged: true,
        packaging: { voices: {}, captions: [] },
      });
      expect(item.snapshot.dependencies).toHaveLength(1);
      expect(item.snapshot.dependencies[0]?.artifactKey).toMatch(/^timeline-project:t:/);
      expect(item.snapshot.timeline.clips).toHaveLength(1);
    }
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });

  it('refreshes the same pending film and lets packaging upgrade it in place', async () => {
    const { service, db, sources, pending } = harness();
    db.workingArtifact.findMany.mockResolvedValue([...sources, confirmedVisual('v0')]);
    await service.upsertFromSmartFill('p', 'w', 't');
    const first = db.effectFinalOutputRun.create.mock.calls[0]![0].data.items.create[0] as {
      variantId: string; name: string; snapshot: FinalOutputSnapshot;
    };
    pending.current = {
      id: 'queued-out', projectId: 'p', templateId: 't', workflowRunId: 'w',
      status: 'PENDING_RENDER', createdAt: new Date(),
      items: [{ id: 'kept', ...first }],
    };

    await service.upsertFromSmartFill('p', 'w', 't');
    expect(db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'kept' } }),
    );
    await service.upsertFromPackaging('p', 'w', 't');
    const upgraded = db.effectFinalOutputItem.update.mock.lastCall![0].data.snapshot as FinalOutputSnapshot;
    expect(upgraded.unpackaged).toBe(false);
    expect(upgraded.dependencies).toHaveLength(2);
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
  });

  it('does not overwrite a delivered branch or accept a stale draft or missing source', async () => {
    const { service, db, sources } = harness();
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources, confirmedVisual('v0'),
      { id: 'delivery', nodeId: 'FINAL_OUTPUT', artifactKey: 'final-delivery:t' },
    ]);
    await service.upsertFromSmartFill('p', 'w', 't');
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();

    db.workingArtifact.findMany.mockResolvedValue([...sources, confirmedVisual('v0')]);
    db.workflowNodeState.findUnique.mockResolvedValueOnce({ revision: 1 })
      .mockResolvedValueOnce({ revision: 2 });
    await expect(service.upsertFromSmartFill('p', 'w', 't')).rejects.toThrow('草稿已变化');
    db.fileObject.findMany.mockResolvedValue([]);
    await expect(service.upsertFromSmartFill('p', 'w', 't')).rejects.toThrow('源文件已失效');
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
  });

  it('does not downgrade a queue once packaging has started', async () => {
    const { service, db, sources } = harness();
    db.workingArtifact.findMany.mockResolvedValue([...sources, confirmedVisual('v0')]);
    db.effectPackagingRun.count.mockResolvedValue(1);
    await service.upsertFromSmartFill('p', 'w', 't');
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });

  it('repairs a confirmed fill whose post-commit sync was missed when output opens', async () => {
    const { service, db, working, sources } = harness();
    working.listArtifacts.mockResolvedValue([...sources, confirmedVisual('v0')]);
    db.effectFinalOutputRun.findMany.mockResolvedValue([]);
    const repair = vi.spyOn(service, 'upsertFromSmartFill').mockResolvedValue(undefined);

    await service.syncFromDraft('p', 'w', { expectedDraftRevision: 1 });

    expect(repair).toHaveBeenCalledWith('p', 'w', 't');
  });
});

describe('atomic full packaging completion', () => {
  it.each([1, 10, 100])(
    'commits all %i visuals and packages as an isolated pending template output',
    async (count) => {
      const { service, db, working, outputRun } = harness(count);
      await service.upsertFromPackaging('p', 'w', 't');
      expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalledTimes(count + 1);
      expect(db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
      expect(outputRun.status).toBe('PENDING_RENDER');
      expect(outputRun.items).toHaveLength(count);
      expect((outputRun.items[0] as { status: string }).status).toBe('PENDING_RENDER');
      const snapshot = (outputRun.items[0] as { snapshot: FinalOutputSnapshot }).snapshot;
      expect(snapshot).toMatchObject({ resolution: '720p', frameRate: 30 });
      expect(snapshot.dependencies).toContainEqual(
        expect.objectContaining({ artifactId: 'timeline-project:t:v0', revision: 2 }),
      );
      expect(snapshot.dependencies).toContainEqual(
        expect.objectContaining({ artifactId: 'timeline-package:t:v0', revision: 2 }),
      );
    },
  );
  it.each(['RUNNING', 'QUEUED'])(
    'waits instead of submitting while the last item is still %s',
    async (status) => {
      const { service, rows, working, db } = harness(100);
      rows[99]!.status = status;
      await expect(service.upsertFromPackaging('p', 'w', 't')).rejects.toThrow('仍在包装中');
      expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
    },
  );
  it.each(['FAILED', 'CANCELLED'])(
    'submits the %s film as a picture-only one instead of blocking the batch',
    async (status) => {
      const { service, rows, db, working } = harness(100);
      rows[99]!.status = status;
      // The failure is the film's own problem; the other 99 were packaged and the user asked for all
      // of them, so the run goes ahead and the silent film is marked as such.
      await service.upsertFromPackaging('p', 'w', 't');
      expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalledTimes(101);
      const items = db.effectFinalOutputRun.create.mock.calls[0]![0].data.items.create as {
        snapshot: FinalOutputSnapshot;
      }[];
      expect(items).toHaveLength(100);
      expect(items[99]!.snapshot).toMatchObject({
        unpackaged: true,
        // The worker reads these keys unconditionally, so an empty shape is what "no package" means.
        packaging: { voices: {}, captions: [] },
      });
      // The packaged neighbours keep their narration.
      expect(items[0]!.snapshot.packaging.voices!['line']).toBeDefined();
      expect(items[0]!.snapshot.unpackaged).toBe(false);
    },
  );
  it('keeps a completed package usable after its source timeline changes', async () => {
    const { service, rows, working } = harness();
    rows[0]!.status = 'FAILED';
    rows[0]!.sourceTimelineHash = 'hash-of-an-older-timeline';
    await expect(service.upsertFromPackaging('p', 'w', 't')).resolves.toBeUndefined();
    expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalled();
  });
  it('tells the output list why a film plays without sound', async () => {
    const { service, rows, outputRun } = harness(2);
    rows[1]!.status = 'FAILED';
    await service.upsertFromPackaging('p', 'w', 't');
    outputRun.status = 'PENDING_RENDER';
    // The frozen snapshot is the only place the reason survives, so the list has to read it back.
    const result = await service.get('p', 'out');
    expect(result.items.map((item) => [item.name, item.unpackaged])).toEqual([
      ['成片0', false],
      ['成片1', true],
    ]);
    expect(result.items.map((item) => item.currentPackagingReady)).toEqual([true, false]);
  });
  it('marks an output item stale without hiding the frozen result', async () => {
    const { service, outputRun, mix, working } = harness();
    const variant = {
      id: 'v0', name: '成片0', slots: [], bindings: {}, bindingRevisions: {}, offsets: {},
    } as unknown as EffectTemplateMixVariant;
    outputRun.items = [{
      id: 'film-item',
      variantId: 'v0',
      name: '成片0',
      status: 'COMPLETED',
      progress: 100,
      errorMessage: null,
      fileObjectId: 'rendered-file',
      assetId: 'rendered-asset',
      snapshot: {
        timeline: {
          variant,
          sourceTimelineHash: 'old-hash',
          duration: 10,
          clips: [{ slotId: 's', start: 0, duration: 10, fileObjectId: 'video' }],
          dependencies: [],
        },
        packaging: { voices: {}, captions: [] },
        unpackaged: true,
        dependencies: [{ artifactId: 'old-source', revision: 1, contentHash: 'old-hash' }],
        aspectRatio: '9:16',
        originalVolume: 0.15,
        resolution: '720p',
        frameRate: 30,
      },
    }];
    mix.workspace.mockResolvedValue({
      materials: [],
      draft: { templates: [{ id: 't', workspace: { template: { name: '模板' }, variants: [variant] } }] },
    } as never);
    working.listArtifacts.mockResolvedValue([{ id: 'delivery', nodeId: 'FINAL_OUTPUT',
      artifactKey: 'final-delivery:t', availability: 'AVAILABLE' }]);
    outputRun.status = 'COMPLETED';
    const result = await service.get('p', 'out');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'film-item', status: 'COMPLETED',
      currentPackagingReady: true, unpackaged: true, fileObjectId: 'rendered-file' });
    expect(result.items[0]?.stale).toBe(true);
  });
  it('still refuses changed draft and missing files but accepts changed source revisions', async () => {
    const { service, db, sources, working } = harness();
    // The draft revision is read twice: once to plan outside the lock, once under the row lock. A save
    // that lands between the two is exactly what the second read is there to catch.
    db.workflowNodeState.findUnique
      .mockResolvedValueOnce({ revision: 1 })
      .mockResolvedValueOnce({ revision: 2 });
    await expect(service.upsertFromPackaging('p', 'w', 't')).rejects.toThrow('草稿');
    db.workflowNodeState.findUnique.mockResolvedValue({ revision: 1 });
    sources[0]!.revision = 2;
    await expect(service.upsertFromPackaging('p', 'w', 't')).resolves.toBeUndefined();
    sources[0]!.revision = 1;
    db.fileObject.findMany.mockResolvedValue([]);
    await expect(service.upsertFromPackaging('p', 'w', 't')).rejects.toThrow('文件');
    expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalled();
  });
  it('rejects unsupported fact IDs without adding AI review', async () => {
    const { service, rows, working } = harness();
    rows[0]!.checkpoint.script[0]!.factIds = ['invented'];
    await expect(service.upsertFromPackaging('p', 'w', 't')).rejects.toThrow();
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
  });
  it('reuses an identical confirmed input instead of queueing a duplicate batch', async () => {
    const { service, db } = harness();
    // The same package submitted twice hashes to the same input, so the run it already produced is the
    // one to keep; the second callback only re-commits the (unchanged) artifacts and republishes.
    db.effectFinalOutputRun.findUnique.mockResolvedValue({ id: 'out' });
    await service.upsertFromPackaging('p', 'w', 't');
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('refreshes the un-exported batch in place instead of growing one run per package', async () => {
    const { service, db, pending, rows } = harness(1);
    pending.current = {
      id: 'queued-out',
      projectId: 'p',
      templateId: 't',
      workflowRunId: 'w',
      status: 'PENDING_RENDER',
      createdAt: new Date(),
      items: [
        { id: 'kept', variantId: 'v0', name: '旧名', snapshot: { stale: true } },
        { id: 'dropped', variantId: 'v9', name: '成片9', snapshot: { stale: true } },
      ],
    };
    await service.upsertFromPackaging('p', 'w', 't');
    // The variant the draft still holds is rewritten where it stands; the one that left is dropped.
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'kept' } }),
    );
    expect(db.effectFinalOutputItem.delete).toHaveBeenCalledWith({ where: { id: 'dropped' } });
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    // The live package still describes the kept variant, so only the orphaned item goes away.
    expect(rows).toHaveLength(1);
  });
  it('accepts editor-edited audio and renders it as a distinct output run', async () => {
    const canonical = harness();
    await canonical.service.upsertFromPackaging('p', 'w', 't');
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
    checkpoint.captions = [{ id: 'line', start: 3, end: 4.5, text: '商品' }];
    await edited.service.upsertFromPackaging('p', 'w', 't');
    expect(edited.db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
    const created = edited.db.effectFinalOutputRun.create.mock.calls[0]![0].data;
    expect(created.inputHash).not.toBe(baseline);
    const item = created.items.create[0] as { snapshot: FinalOutputSnapshot };
    expect(item.snapshot.packaging.voices!['line']).toMatchObject({ start: 3, offset: 0.5 });
    expect(item.snapshot.packaging.captions).toEqual([
      { id: 'line', start: 3, end: 4.5, text: '商品' },
    ]);
  });
  it('renders the film as long as its content, black tail included', async () => {
    const { service, db, working, rows } = harness();
    // A track carried past the last video clip is what extends the film, so the two numbers have to
    // disagree here: the frozen snapshot stays video-only while the render length follows the content.
    const checkpoint = rows[0]!.checkpoint as PackagingCheckpoint;
    checkpoint.music = { fileObjectId: 'music', start: 0, duration: 14, volume: 0.2 };
    checkpoint.captions = [{ id: 'line', start: 12, end: 13, text: '商品' }];
    await service.upsertFromPackaging('p', 'w', 't');
    const item = db.effectFinalOutputRun.create.mock.calls[0]![0].data.items.create[0] as {
      snapshot: FinalOutputSnapshot;
    };
    expect(item.snapshot.timeline.duration).toBe(14);
    expect(item.snapshot.timeline.clips[0]!.duration).toBe(10);
    // The package the worker reads has to agree, or the tail would be cut off at the last clip.
    const payload = working.commitValidatedArtifactsInTransaction.mock.calls
      .flatMap((call) => call[4] as { artifactKey: string; input: { payload: { duration: number } } }[])
      .find((entry) => entry.artifactKey === 'timeline-package:t:v0')!;
    expect(payload.input.payload.duration).toBe(14);
  });
  it('folds a live overlay into the timeline and gives it an output run of its own', async () => {
    const plain = harness();
    await plain.service.upsertFromPackaging('p', 'w', 't');
    const baseline = plain.db.effectFinalOutputRun.create.mock.calls[0]![0].data.inputHash;

    const { service, db, mix, rows } = harness();
    // The package never froze the overlay — that is what keeps it from locking the captions and
    // audio — so the export has to read it from the live draft, and read every row from the draft
    // too: opening the overlay's row pushed the narrated clip down, and keeping the frozen row
    // number would put the overlay beside the clip it is meant to cover.
    const variant = rows[0]!.snapshot.variant;
    variant.slots.push({
      id: 'overlay',
      role: 'PRODUCT',
      purpose: 'PRODUCT_DISPLAY',
      label: '叠加',
      duration: 6,
      transition: '硬切',
      overlay: true,
    });
    variant.bindings.overlay = 'overlay-clip';
    variant.bindingRevisions.overlay = 1;
    variant.offsets.overlay = 0;
    variant.timelineStarts = { overlay: 3 };
    variant.videoLanes = { s: 1, overlay: 0 };
    mix.workspace.mockResolvedValue({
      materials: [
        {
          id: 'overlay-clip',
          artifactId: 'overlay-source',
          fileObjectId: 'overlay-video',
          duration: 15,
          available: true,
          artifactRevision: 1,
          contentHash: 'overlay-hash',
        },
      ],
    });
    const prompt = {
      sourceType: 'WORKING_ARTIFACT',
      sourceArtifactId: 'prompt',
      sourceRevision: 1,
    };
    db.workingArtifact.findMany.mockResolvedValue([
      { id: 'source', revision: 1, contentHash: 'hash', freshness: 'CURRENT', availability: 'AVAILABLE', dependencies: [] },
      {
        id: 'overlay-source',
        revision: 1,
        contentHash: 'overlay-hash',
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
        artifactKey: 'render-clip:o',
        payload: { promptId: 'p' },
        dependencies: [prompt],
      },
      {
        id: 'prompt',
        revision: 1,
        contentHash: 'prompt-hash',
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
        artifactKey: 'prompt-batch:p',
        payload: { items: [{ id: 'p', content: '叠加层原始 Prompt' }] },
        dependencies: [],
      },
    ]);
    db.fileObject.findMany.mockResolvedValue(
      ['video', 'voice', 'music', 'overlay-video'].map((id) => ({
        id,
        originalFileName: id,
        mimeType: 'video/mp4',
        sha256: id,
      })),
    );

    await service.upsertFromPackaging('p', 'w', 't');
    const created = db.effectFinalOutputRun.create.mock.calls[0]![0].data;
    // The visual hash is blind to overlays, so without its own key an export that added one would
    // dedupe back to the run it built before the overlay existed.
    expect(created.inputHash).not.toBe(baseline);
    const item = created.items.create[0] as { snapshot: FinalOutputSnapshot };
    expect(item.snapshot.timeline.clips.map((clip) => [clip.slotId, clip.overlay, clip.lane])).toEqual(
      [
        ['s', undefined, 1],
        ['overlay', true, 0],
      ],
    );
  });
  it('queues the batch under a deterministic key so a repackage cannot duplicate it', async () => {
    const { service, db } = harness();
    await service.upsertFromPackaging('p', 'w', 't');
    const created = db.effectFinalOutputRun.create.mock.calls[0]![0].data;
    // The key is derived from the input, not from a per-click UUID: the same package always names the
    // same version, which is what lets the unique index reject a double submit.
    expect(created.idempotencyKey).toBe(`auto:w:t:${created.inputHash}`);
    expect(created.requestHash).toBe(created.inputHash);
  });
  it('freezes resolution and frame rate and enqueues only after explicit export', async () => {
    const { service, db, outputRun } = harness();
    await service.upsertFromPackaging('p', 'w', 't');
    // This fixture has no live draft bindings; the export test covers settings, not draft drift.
    vi.spyOn(service as unknown as { draftDiffersFromSnapshot: (...args: unknown[]) => boolean },
      'draftDiffersFromSnapshot').mockReturnValue(false);
    await service.start('p', 'out', { resolution: '1080p', frameRate: 50 });
    expect(db.effectFinalOutputRun.update).toHaveBeenCalledWith({
      where: { id: 'out' },
      data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null },
    });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'QUEUED', snapshot: expect.objectContaining({ resolution: '1080p', frameRate: 50 }) }),
    }));
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(outputRun.status).toBe('QUEUED');
    // An in-flight batch is the one thing a re-export must not touch.
    await expect(service.start('p', 'out', { resolution: '480p', frameRate: 24 })).rejects.toThrow('不能修改');
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('rejects a missing active context before creating an export branch or enqueueing', async () => {
    const { service, db, working } = harness();
    db.workflowRun.findFirst.mockResolvedValue(null as never);
    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 }))
      .rejects.toThrow('请先保存或取消当前编辑');
    expect(db.workflowRun.findFirst).toHaveBeenCalledWith({ where: {
      projectId: 'p', workflow: 'EFFECT', workflowSpace: 'EFFECT',
      activeKey: 'ACTIVE', status: { in: ['ACTIVE', 'PAUSED'] },
    }, select: { id: true, editSessionNodeId: true } });
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('looks up the selected batch within the project before any export mutation', async () => {
    const { service, db, working } = harness();
    db.effectFinalOutputRun.findFirst.mockResolvedValue(null);
    await expect(service.start('another-project', 'out', { resolution: '720p', frameRate: 30 }))
      .rejects.toThrow('成片输出任务不存在');
    expect(db.effectFinalOutputRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'another-project', id: 'out' },
    }));
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('allows the user to export a package snapshot after editing the draft', async () => {
    const { service, db, working } = harness();
    await service.upsertFromPackaging('p', 'w', 't');
    vi.spyOn(service as unknown as { draftDiffersFromSnapshot: (...args: unknown[]) => boolean },
      'draftDiffersFromSnapshot').mockReturnValue(true);
    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 })).resolves.toBeDefined();
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH', {
      always: true, keepParentActive: true,
      templateId: 't',
      templateScopeActiveRunId: 'w',
    });
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it.each(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])(
    're-exports a %s batch by resetting every item and rewriting the batch spec',
    async (status) => {
      const { service, db, outputRun, sources } = harness(3);
      await service.upsertFromPackaging('p', 'w', 't');
      outputRun.status = status;
      const items = outputRun.items as { status: string; snapshot: FinalOutputSnapshot }[];
      items.forEach((item) => { item.status = status; });
      db.workingArtifact.findMany.mockResolvedValue([...sources, ...currentRows(items)]);

      await service.start('p', 'out', { resolution: '480p', frameRate: 24 });

      expect(db.effectFinalOutputItem.update).toHaveBeenCalledTimes(3);
      for (const [call] of db.effectFinalOutputItem.update.mock.calls) {
        expect(call.data).toMatchObject({ status: 'QUEUED', progress: 0, errorMessage: null });
        expect(call.data.snapshot).toMatchObject({ resolution: '480p', frameRate: 24 });
      }
      expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    },
  );
  it('allows re-exporting the frozen film after its upstream package went stale', async () => {
    const { service, db, outputRun, sources } = harness(2);
    await service.upsertFromPackaging('p', 'w', 't');
    outputRun.status = 'COMPLETED';
    const items = outputRun.items as { status: string; snapshot: FinalOutputSnapshot }[];
    items.forEach((item) => { item.status = 'COMPLETED'; });
    // Bump the package revision: the batch was exported against revision 2.
    db.workingArtifact.findMany.mockResolvedValue(
      [...sources, ...currentRows(items)].map((row) =>
        row.id.startsWith('timeline-package:') ? { ...row, revision: 9 } : row,
      ),
    );

    await service.start('p', 'out', { resolution: '1080p', frameRate: 50 });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalled();
    expect(db.jobOutbox.upsert).toHaveBeenCalled();
    expect(outputRun.status).toBe('QUEUED');
  });
  it('exports inside the forked child Run once a published version is protected', async () => {
    const { service, db, working, outputRun, sources } = harness();
    await service.upsertFromPackaging('p', 'w', 't');
    outputRun.status = 'COMPLETED';
    db.workingArtifact.findMany.mockResolvedValue(
      [...sources, ...currentRows(outputRun.items as { snapshot: FinalOutputSnapshot }[])],
    );
    working.beginEffectNodeEdit.mockResolvedValue({
      runId: 'child-run',
      parentWorkflowRunId: 'w',
      productIdMap: {},
      taskIdMap: {},
      created: true,
    });
    // The source lookup names the batch it exports; the batch lookup then has to find the copy the
    // fork cloned into the child Run rather than the published one.
    db.effectFinalOutputRun.findFirst.mockImplementation((args: { select?: { id?: boolean } }) =>
      Promise.resolve(args?.select?.id ? { id: 'child-out' } : outputRun));

    await service.start('p', 'out', { resolution: '1080p', frameRate: 50 });

    // `always` is what makes an export branch even when it is the project's first one.
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH', {
      always: true, keepParentActive: true,
      templateId: 't',
      templateScopeActiveRunId: 'w',
    });
    expect(db.effectFinalOutputRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'child-out' },
    }));
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('publishes the mix branch once its packaging is validated', async () => {
    const { service, db, working } = harness();
    db.workflowRun.findFirst.mockResolvedValue({
      parentWorkflowRunId: 'w',
      branchPublishedAt: null,
      editSessionNodeId: 'TEMPLATE_MIX',
      forkNodeId: 'TEMPLATE_MIX',
    });
    await service.upsertFromPackaging('p', 'w', 't');
    expect(working.publishEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'TEMPLATE_MIX');
  });
  it('publishes a mix branch that was opened without an edit session', async () => {
    const { service, db, working } = harness();
    // Regenerating opens the branch itself: there is no session to recognise it by, so the fork it
    // was created for is what says the branch belongs to this node.
    db.workflowRun.findFirst.mockResolvedValue({
      parentWorkflowRunId: 'w',
      branchPublishedAt: null,
      editSessionNodeId: null,
      forkNodeId: 'TEMPLATE_MIX',
    });
    await service.upsertFromPackaging('p', 'w', 't');
    expect(working.publishEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'TEMPLATE_MIX');
  });
  it('leaves a partially packaged batch unpublished while still queueing its films', async () => {
    const { service, db, working } = harness();
    db.workflowRun.findFirst.mockResolvedValue({
      parentWorkflowRunId: 'w',
      branchPublishedAt: null,
      editSessionNodeId: null,
      forkNodeId: 'TEMPLATE_MIX',
    });
    // The films the run did package are still worth exporting, so the queue is fed; the branch only
    // appears once the failed ones are recovered in the packaging panel and the batch finishes whole.
    await service.upsertFromPackaging('p', 'w', 't', { publish: false });
    expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalled();
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('leaves a published or unrelated Run alone when the mix validation finishes', async () => {
    const { service, db, working } = harness();
    db.workflowRun.findFirst.mockResolvedValue({
      parentWorkflowRunId: 'w',
      branchPublishedAt: null,
      editSessionNodeId: 'FINAL_OUTPUT',
      forkNodeId: 'FINAL_OUTPUT',
    });
    await service.upsertFromPackaging('p', 'w', 't');
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
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

  it('requeues an expired attempt without resetting completed item results', async () => {
    const { service, db } = harness();
    db.effectFinalOutputRun.findMany.mockResolvedValue([{ id: 'out', projectId: 'p' }]);
    await service.recoverExpired();
    expect(db.effectFinalOutputRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'out', status: 'RUNNING' }),
        data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null },
      }),
    );
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(db.effectFinalOutputItem.updateMany).not.toHaveBeenCalled();
  });
});

/** Completes a batch, then hands back an exported run with stable item ids and upstream rows. */
async function exportedRun(count = 2) {
  const context = harness(count);
  await context.service.upsertFromPackaging('p', 'w', 't');
  const items = context.outputRun.items as {
    id: string;
    status: string;
    snapshot: FinalOutputSnapshot;
    fileObjectId?: string | null;
    assetId?: string | null;
  }[];
  items.forEach((item, index) => {
    item.id = `item-${index}`;
    item.status = 'COMPLETED';
    item.fileObjectId = `old-file-${index}`;
    item.assetId = `old-asset-${index}`;
  });
  context.outputRun.status = 'COMPLETED';
  context.db.workingArtifact.findMany.mockResolvedValue(currentRows(items));
  return { ...context, items };
}

describe('picture-only output items', () => {
  /** An exported batch whose first item was confirmed without a package. */
  async function unpackaged() {
    const context = await exportedRun();
    const { db, items } = context;
    const item = items[0]!;
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    snapshot.unpackaged = true;
    snapshot.packaging = { voices: {}, captions: [] } as unknown as PackagingCheckpoint;
    // Only the picture is downloaded now: an empty package contributes no audio ids.
    db.fileObject.count.mockResolvedValue(1);
    db.fileObject.findFirstOrThrow.mockResolvedValue({
      storageKey: 'stored/video.mp4',
      mimeType: 'video/mp4',
      sha256: 'a'.repeat(64),
    });
    db.effectFinalOutputItem.findFirst.mockResolvedValue({
      ...item,
      status: 'QUEUED',
      run: { workflowRunId: 'w', templateId: 't' },
    });
    return { ...context, item };
  }

  it('lets the worker fetch its sources and report progress', async () => {
    const { service, db } = await unpackaged();
    // `current()` used to apply the narrated-package rules to every item, so a picture-only film
    // died on its very first progress ping with "输出来源或结果校验失败，请回模板混剪恢复".
    await service.progress('p', 'out', 'token', 'item-0', 1);
    expect(db.effectFinalOutputItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RUNNING', progress: 1 }),
      }),
    );
    const file = await service.content('p', 'out', 'token', 'item-0', 'video');
    expect(file.mimeType).toBe('video/mp4');
    expect(file.sha256).toBe('a'.repeat(64));
  });

  it('rejects a picture-only snapshot missing the keys the renderer reads', async () => {
    const { service, db, item } = await unpackaged();
    db.effectFinalOutputItem.findFirst.mockResolvedValue({
      ...item,
      status: 'QUEUED',
      run: { workflowRunId: 'w', templateId: 't' },
      // The worker does `packaging['voices'].values()` and `packaging['captions']`, so a snapshot
      // that dropped either would fail deep inside the render instead of here.
      snapshot: { ...(item.snapshot as object), packaging: { captions: [] } },
    });
    await expect(service.progress('p', 'out', 'token', 'item-0', 1)).rejects.toThrow(
      '无包装成片的结构无效',
    );
    expect(db.effectFinalOutputItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('single item re-render', () => {
  it('resets exactly one item, keeps its own snapshot and enqueues once', async () => {
    const { service, db, items } = await exportedRun();
    const before = JSON.stringify(items[0]!.snapshot);

    await service.renderItem('p', 'out', 'item-0');

    expect(db.effectFinalOutputItem.update).toHaveBeenCalledOnce();
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith({
      where: { id: 'item-0' },
      data: { status: 'QUEUED', progress: 0, errorMessage: null },
    });
    // The batch spec must survive a single-item re-render untouched (toDto reads items[0]).
    expect(JSON.stringify(items[0]!.snapshot)).toBe(before);
    expect(items[0]!.status).toBe('QUEUED');
    expect(items[1]!.status).toBe('COMPLETED');
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it.each([
    ['QUEUED', '正在渲染'],
    ['RUNNING', '正在渲染'],
    ['PENDING_RENDER', '尚未导出'],
  ])('refuses to re-render one item while the run is %s', async (status, message) => {
    const { service, db, outputRun } = await exportedRun();
    outputRun.status = status;
    await expect(service.renderItem('p', 'out', 'item-0')).rejects.toThrow(message);
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('reports a missing item instead of re-queueing the batch', async () => {
    const { service, db } = await exportedRun();
    await expect(service.renderItem('p', 'out', 'missing')).rejects.toThrow('条目不存在');
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });
  it('re-renders a frozen item after its upstream artifacts become stale', async () => {
    const { service, db, items } = await exportedRun();
    db.workingArtifact.findMany.mockResolvedValue(currentRows(items).slice(0, 1));
    await service.renderItem('p', 'out', 'item-0');
    expect(items[0]!.status).toBe('QUEUED');
    expect(db.jobOutbox.upsert).toHaveBeenCalled();
  });
});

describe('re-render overwrites the previous artifact in place', () => {
  async function prepareUpload() {
    const context = await exportedRun();
    const { db, working, items } = context;
    const item = items[0]!;
    db.effectFinalOutputItem.findFirst.mockResolvedValue({
      ...item,
      // claim() hands the worker only non-COMPLETED items, so an upload always sees QUEUED.
      status: 'QUEUED',
      run: { workflowRunId: 'w', templateId: 't' },
    });
    db.effectFinalOutputItem.findUniqueOrThrow.mockResolvedValue({
      status: 'QUEUED',
      fileObjectId: 'old-file-0',
      assetId: 'old-asset-0',
    });
    working.commitValidatedArtifactsInTransaction.mockResolvedValue([
      {
        artifactKey: 'final-video:t:v0',
        record: {
          id: 'final-video:t:v0',
          artifactKey: 'final-video:t:v0',
          nodeId: 'FINAL_OUTPUT',
          revision: 2,
          contentHash: 'output-hash',
        },
        previousStorageKey: 'stored/old.mp4',
        unchanged: false,
        orphanedFileObjectIds: ['old-file-0'],
      },
    ]);
    return { ...context, item };
  }

  it('releases the old pointer before the artifact commit and updates the asset in place', async () => {
    const { service, db, working, items } = await prepareUpload();
    const file = await outputFile();
    try {
      const result = await service.upload('p', 'out', 'token', 'item-0', {
        path: file.path,
        size: file.size,
      });

      // The orphan guard (finalOutputItems: { none: {} }) only fires if the item let go first.
      const repoint = db.effectFinalOutputItem.update.mock.calls.findIndex(
        (call) => call[0].data.fileObjectId === null,
      );
      expect(repoint).toBeGreaterThanOrEqual(0);
      // The commit mock was already exercised by complete(), so compare against its last call.
      expect(db.effectFinalOutputItem.update.mock.invocationCallOrder[repoint]).toBeLessThan(
        working.commitValidatedArtifactsInTransaction.mock.invocationCallOrder.at(-1)!,
      );

      expect(db.asset.create).not.toHaveBeenCalled();
      expect(db.assetVersion.deleteMany).toHaveBeenCalledWith({
        where: { projectId: 'p', assetId: 'old-asset-0' },
      });
      expect(db.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'old-asset-0' }, data: expect.objectContaining({ currentVersion: 1 }) }),
      );
      expect(db.assetVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assetId: 'old-asset-0', version: 1 }) }),
      );
      expect(working.enqueueCleanup).toHaveBeenCalledWith('p', 'stored/old.mp4', 'FINAL_OUTPUT_REPLACED');
      expect(items[0]!.fileObjectId).toBe('new-file');
      expect(result).toEqual({ fileObjectId: 'new-file' });
    } finally {
      await file.cleanup();
    }
  });

  it('keeps the previous output when the upload fails', async () => {
    const { service, db, working, storage, outputRun } = await prepareUpload();
    const file = await outputFile();
    db.asset.update.mockRejectedValueOnce(new Error('db down'));
    try {
      await expect(
        service.upload('p', 'out', 'token', 'item-0', { path: file.path, size: file.size }),
      ).rejects.toThrow('db down');
      // The whole transaction rolled back: the item still points at the surviving output.
      const item = (outputRun.items as { fileObjectId?: string | null; assetId?: string | null; status: string }[])[0]!;
      expect(item.fileObjectId).toBe('old-file-0');
      expect(item.assetId).toBe('old-asset-0');
      expect(item.status).toBe('COMPLETED');
      expect(working.enqueueCleanup).not.toHaveBeenCalled();
      // Only the aborted attempt's own blob is discarded.
      expect(storage.delete).toHaveBeenCalledWith('stored/new.mp4');
    } finally {
      await file.cleanup();
    }
  });

  it('does not leak a second blob when the re-render is byte-identical', async () => {
    const { service, db, working, storage, items } = await prepareUpload();
    working.commitValidatedArtifactsInTransaction.mockResolvedValue([
      {
        artifactKey: 'final-video:t:v0',
        record: { id: 'final-video:t:v0', artifactKey: 'final-video:t:v0', nodeId: 'FINAL_OUTPUT', revision: 1, contentHash: 'output-hash' },
        previousStorageKey: 'stored/old.mp4',
        unchanged: true,
        orphanedFileObjectIds: [],
      },
    ]);
    const file = await outputFile();
    try {
      const result = await service.upload('p', 'out', 'token', 'item-0', {
        path: file.path,
        size: file.size,
      });
      // The artifact still owns stored/old.mp4, so nothing may schedule its deletion.
      expect(working.enqueueCleanup).not.toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledWith('stored/new.mp4');
      expect(db.fileObject.delete).toHaveBeenCalledWith({ where: { id: 'new-file' } });
      expect(items[0]!.fileObjectId).toBe('old-file-0');
      expect(items[0]!.assetId).toBe('old-asset-0');
      expect(items[0]!.status).toBe('COMPLETED');
      expect(result).toEqual({ fileObjectId: 'old-file-0' });
    } finally {
      await file.cleanup();
    }
  });
});

describe('independent full export and current-branch local update', () => {
  it('freezes latest geometry in every child film while local update queues only the selected parent film', async () => {
    const { service, db, working, mix, run, workspace, variant, artifacts } = await localUpdateHarness();
    const sourceItems = run.items as { id: string; variantId: string; snapshot: FinalOutputSnapshot;
      status: string; fileObjectId: string | null; assetId: string | null }[];
    const second = structuredClone(sourceItems[0]!);
    second.id = 'item-1'; second.variantId = 'v1'; second.snapshot.timeline.variant.id = 'v1';
    second.fileObjectId = 'old-file-1'; second.assetId = 'old-asset-1';
    sourceItems.push(second);
    const secondVariant = structuredClone(variant); secondVariant.id = 'v1';
    workspace.draft.templates[0]!.workspace.variants.push(secondVariant);
    // Packaging is already frozen in these picture-only fixtures; focus on changed engineering.
    db.effectPackagingItem.findMany.mockResolvedValue([]);
    const old = structuredClone(run);
    variant.offsets.s = 1;
    const frozenWorkspace = structuredClone(workspace);
    const child = { ...structuredClone(run), id: 'child-output', workflowRunId: 'child',
      status: 'PENDING_RENDER', items: sourceItems.map((item) => ({ ...structuredClone(item),
        id: `child-${item.id}`, status: 'PENDING_RENDER', fileObjectId: null, assetId: null })) };
    const batches = [run, child];
    const allItems = () => batches.flatMap((batch) => batch.items) as typeof sourceItems;
    db.effectFinalOutputRun.findFirst.mockImplementation((args) => Promise.resolve(
      args.where?.workflowRunId === 'child' ? child : args.where?.id === child.id ? child : run));
    db.effectFinalOutputRun.update.mockImplementation(({ where, data }) =>
      Object.assign(batches.find((batch) => batch.id === where.id)!, data));
    db.effectFinalOutputItem.update.mockImplementation(({ where, data }) =>
      Object.assign(allItems().find((item) => item.id === where.id)!, data));
    db.effectFinalOutputItem.findUniqueOrThrow.mockImplementation(({ where }) =>
      Promise.resolve(allItems().find((item) => item.id === where.id)));
    mix.outputSourceWorkspace.mockImplementation(async (_p, id) =>
      ({ ...(id === 'child' ? frozenWorkspace : workspace), artifacts }) as never);
    mix.workspace.mockImplementation(async (_p, id) =>
      (id === 'child' ? frozenWorkspace : workspace) as never);
    working.beginEffectNodeEdit.mockResolvedValue({ runId: 'child', parentWorkflowRunId: 'w',
      productIdMap: {}, taskIdMap: {}, created: true });
    await service.start('p', run.id, { resolution: '1080p', frameRate: 50 });
    expect(run).toEqual(old);
    expect(child.items).toHaveLength(2);
    expect(child.items.every((item) => item.status === 'QUEUED')).toBe(true);
    expect(child.items[0]!.snapshot.timeline.clips[0]!.offset).toBe(1);
    expect(child.items[1]!.snapshot.timeline.clips[0]!.offset).toBe(0);
    expect(child.items.every((item) => item.snapshot.resolution === '1080p')).toBe(true);
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH',
      expect.objectContaining({ keepParentActive: true }));
    // Another save after the fork must affect only the explicit parent update, not frozen child input.
    variant.offsets.s = 2;
    await service.localUpdate('p', run.id, { itemIds: ['item-0'] });
    expect(sourceItems[0]!.snapshot.timeline.clips[0]!.offset).toBe(2);
    expect(sourceItems[0]!.snapshot.resolution).toBe('720p');
    expect(sourceItems[0]!.fileObjectId).toBe('old-file-0');
    expect(sourceItems[1]).toEqual(old.items[1]);
    expect(child.items[0]!.snapshot.timeline.clips[0]!.offset).toBe(1);
    expect(db.jobOutbox.upsert.mock.calls.map(([args]) => args.create.aggregateId))
      .toEqual(['child-output', 'out']);
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
  });
  it.each(['missing', 'incomplete', 'unavailable'])(
    'rejects %s current engineering without enqueueing or changing source files', async (failure) => {
      const { service, db, working, mix, run, workspace, variant } = await localUpdateHarness();
      const old = structuredClone(run);
      if (failure === 'missing') workspace.draft.templates[0]!.workspace.variants = [];
      if (failure === 'incomplete') variant.bindings = {};
      if (failure === 'unavailable') workspace.materials[0]!.available = false;
      mix.outputSourceWorkspace.mockResolvedValue(workspace as never);
      await expect(service.start('p', run.id, { resolution: '720p', frameRate: 30 })).rejects.toThrow();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
      expect(run).toEqual(old);
      expect(db.effectFinalOutputRun.updateMany).toHaveBeenCalledWith({
        where: { projectId: 'p', id: 'out', status: 'PENDING_RENDER' },
        data: { status: 'FAILED', completedAt: expect.any(Date) },
      });
      expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
    });
});

/** An exported batch whose delivery manifest can actually be written. */
async function delivered(count = 2) {
  const context = await exportedRun(count);
  // Delivery fixtures intentionally omit the live material bindings; they test file and manifest
  // integrity, while draft-picture drift is covered by the queue synchronization tests.
  vi.spyOn(context.service as unknown as { draftDiffersFromSnapshot: (...args: unknown[]) => boolean },
    'draftDiffersFromSnapshot').mockReturnValue(false);
  const { db, mix, working } = context;
  const items = context.items;
  const variants = items.map(
    (item) => (item.snapshot as unknown as FinalOutputSnapshot).timeline.variant,
  );
  mix.workspace.mockResolvedValue({
    materials: [{ fileObjectId: 'video', ratio: '3:4' }],
    draft: { templates: [{ id: 't', workspace: { template: { name: '模板' }, variants } }] },
  } as never);
  db.fileObject.findMany.mockResolvedValue(
    items.map((item, index) => ({
      id: item.fileObjectId!,
      originalFileName: `成片${index}.mp4`,
      mimeType: 'video/mp4',
      sha256: 'f'.repeat(64),
      storageKey: `stored/${index}.mp4`,
    })),
  );
  db.asset.findMany.mockResolvedValue(
    items.map((item, index) => ({
      id: item.assetId!,
      type: 'FINAL_VIDEO',
      status: 'AVAILABLE',
      sourceArtifactId: `final-video:t:v${index}`,
      storageKey: `stored/${index}.mp4`,
    })),
  );
  db.workingArtifact.findMany.mockResolvedValue([
    ...currentRows(items),
    ...items.map((item, index) => ({
      id: `final-video:t:v${index}`,
      artifactKey: `final-video:t:v${index}`,
      nodeId: 'FINAL_OUTPUT',
      revision: 1,
      contentHash: `video-hash-${index}`,
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      files: [{ fileObjectId: item.fileObjectId! }],
    })),
  ]);
  db.effectFinalOutputItem.findMany.mockResolvedValue(items);
  db.workflowRun.findFirst.mockResolvedValue({
    parentWorkflowRunId: 'parent',
    branchPublishedAt: null,
    editSessionNodeId: 'FINAL_OUTPUT',
  });
  return { ...context, items, working, variants };
}

describe('finishing a batch', () => {
  it('writes the delivery manifest and publishes the output branch once every film succeeded', async () => {
    const { service, working } = await delivered();
    await expect(service.finish('p', 'out', 'token')).resolves.toEqual({ accepted: true });
    expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'p',
      'w',
      'FINAL_OUTPUT',
      [expect.objectContaining({ artifactKey: 'final-delivery:t' })],
    );
    expect(working.publishEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT');
  });
  it('leaves a batch with a failed film unpublished', async () => {
    const { service, db, working, items } = await delivered();
    items[1]!.status = 'FAILED';
    vi.clearAllMocks();
    db.effectFinalOutputItem.findMany.mockResolvedValue(items);
    await expect(service.finish('p', 'out', 'token')).resolves.toEqual({ accepted: true });
    // A batch the user has to retry is not a version; only the run's own status moved.
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
  });
  it('still accepts the finish when the manifest cannot be written', async () => {
    const { service, db, working, items } = await delivered();
    vi.clearAllMocks();
    db.effectFinalOutputItem.findMany.mockResolvedValue(items);
    // A deleted asset is the worker's problem to report, not a reason to fail its own callback.
    db.asset.findMany.mockResolvedValue([]);
    await expect(service.finish('p', 'out', 'token')).resolves.toEqual({ accepted: true });
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
  });
});

describe('saved mix drafts re-sync only the unexported output queue', () => {
  it('exports a template tip even when another template owns the global active pointer', async () => {
    const { service, db, working } = harness();
    await service.upsertFromPackaging('p', 'w', 't');
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({ projectId: 'p',
      activeWorkflowRunId: 'other', branches: [
        { workflowRunId: 'root', parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null,
          createdAt: '0', templates: [{ templateId: 't' }, { templateId: 'other' }] },
        { workflowRunId: 'w', parentWorkflowRunId: 'root', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 't',
          createdAt: '1', templates: [{ templateId: 't' }, { templateId: 'other' }] },
        { workflowRunId: 'other', parentWorkflowRunId: 'w', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 'other',
          createdAt: '2', templates: [{ templateId: 't' }, { templateId: 'other' }] },
      ] } as never);
    db.workflowRun.findFirst.mockResolvedValue({ id: 'other' });
    await service.start('p', 'out', { resolution: '720p', frameRate: 30 });
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH', {
      always: true, keepParentActive: true, templateId: 't', templateScopeActiveRunId: 'other',
    });
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('rejects a replaced batch without creating a branch', async () => {
    const { service, db, working } = harness();
    db.effectFinalOutputRun.findMany.mockResolvedValue([]);
    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 }))
      .rejects.toThrow('成片工程已变化');
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('rejects activity that changes after template-tip resolution', async () => {
    const { service, db, working } = harness();
    db.workflowRun.findFirst.mockResolvedValue({ id: 'changed' });
    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 }))
      .rejects.toThrow('工作流分支正在更新');
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('lists only the batch belonging to each resolved template tip', async () => {
    const { service } = harness();
    const path = vi.spyOn(service, 'listPath');
    const result = await service.list('p', 'w');
    expect(result.map((batch) => batch.id)).toEqual(['out']);
    expect(path).toHaveBeenCalledWith('p', 'w', new Set(['t']));
    expect(await service.list('p', 'unknown')).toEqual([]);
  });
  it('shares one scoped catalog read across template paths without leaking sibling batches', async () => {
    const { service, db, outputRun } = harness();
    const tree = [
      { workflowRunId: 'w', parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null,
        createdAt: '2026-10-04T00:00:00Z', templates: [{ templateId: 't' }, { templateId: 'other' }] },
      { workflowRunId: 'child', parentWorkflowRunId: 'w', forkNodeId: 'FINAL_OUTPUT', forkTemplateId: 'other',
        createdAt: '2026-10-04T00:01:00Z', templates: [{ templateId: 't' }, { templateId: 'other' }] },
    ];
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({ projectId: 'p',
      activeWorkflowRunId: 'child', branches: tree } as never);
    db.workflowRun.findMany.mockResolvedValue(tree.map((branch) => ({ ...branch, id: branch.workflowRunId })) as never);
    const other = { ...outputRun, id: 'other-output', templateId: 'other', workflowRunId: 'child' };
    db.effectFinalOutputRun.findMany.mockResolvedValue([
      { ...outputRun, id: 'sibling-output', workflowRunId: 'sibling' }, other, outputRun,
    ] as never);
    const result = await service.list('p', 'child');
    expect(result.map((batch) => batch.id)).toEqual(['out', 'other-output']);
    expect(db.workflowRun.findMany).toHaveBeenCalledTimes(2);
    expect(db.effectFinalOutputRun.findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: { projectId: 'p', workflowRunId: { in: ['child', 'w'] } },
    }));
    expect(db.workingArtifact.findMany).not.toHaveBeenCalled();
  });
  it('keeps an unpublished output child visible while it renders', async () => {
    const { service, db } = harness();
    db.workflowRun.findFirst.mockResolvedValue({ id: 'child', parentWorkflowRunId: 'w',
      forkNodeId: 'FINAL_OUTPUT', forkTemplateId: 't' } as never);
    vi.spyOn(service, 'listPath').mockResolvedValue([{ id: 'running', templateId: 't' }] as never);
    expect((await service.list('p', 'child')).map((batch) => batch.id)).toEqual(['running']);
    expect(service.listPath).toHaveBeenCalledWith('p', 'child', new Set(['t']));
  });
  it('lists the nearest confirmed output batch for each template on the current branch path', async () => {
    const { service, db, mix, working, run } = await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    const older = { ...run, id: 'older-output', workflowRunId: 'parent', templateId: 'other-template' };
    run.workflowRunId = 'child';
    db.workflowRun.findMany.mockResolvedValue([
      { id: 'child', parentWorkflowRunId: 'parent', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 't' },
      { id: 'parent', parentWorkflowRunId: null, forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 'other-template' },
    ]);
    db.effectFinalOutputRun.findMany.mockResolvedValue([run, older]);
    const listed = await service.listPath('p', 'child');
    expect(listed.map((batch) => [batch.templateId, batch.workflowRunId])).toEqual([
      ['t', 'child'], ['other-template', 'parent'],
    ]);
    expect(mix.workspace).not.toHaveBeenCalled();
    expect(mix.outputSourceWorkspace).toHaveBeenCalledTimes(1);
    expect(working.listArtifacts).not.toHaveBeenCalled();
  });

  it('does not revive an older batch of the template being forked', async () => {
    const { service, db, run } = await localUpdateHarness(false);
    run.workflowRunId = 'parent';
    db.workflowRun.findMany.mockResolvedValue([
      { id: 'child', parentWorkflowRunId: 'parent', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 't' },
      { id: 'parent', parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null },
    ]);
    db.effectFinalOutputRun.findMany.mockResolvedValue([run]);
    expect(await service.listPath('p', 'child')).toEqual([]);
  });

  it('projects freshness only for the requested template tip, without reading other inherited sources', async () => {
    const { service, db, mix, run } = await localUpdateHarness();
    db.workflowRun.findMany.mockResolvedValue([
      { id: 'w', parentWorkflowRunId: 'parent', forkNodeId: 'FINAL_OUTPUT', forkTemplateId: 't' },
      { id: 'parent', parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null },
    ]);
    db.effectFinalOutputRun.findMany.mockResolvedValue([
      run, { ...run, id: 'other-output', workflowRunId: 'parent', templateId: 'other-template' },
    ]);
    const listed = await service.listPath('p', 'w', new Set(['t']));
    expect(listed.map((batch) => batch.templateId)).toEqual(['t']);
    expect(mix.outputSourceWorkspace).toHaveBeenCalledExactlyOnceWith('p', 'w');
  });

  it('infers the template scope of a legacy fork from its own output batch', async () => {
    const { service, db, run } = await localUpdateHarness(false);
    const older = { ...run, id: 'older-output', workflowRunId: 'parent', templateId: 'other-template' };
    run.workflowRunId = 'child';
    db.workflowRun.findMany.mockResolvedValue([
      { id: 'child', parentWorkflowRunId: 'parent', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: null },
      { id: 'parent', parentWorkflowRunId: null, forkNodeId: 'TEMPLATE_MIX', forkTemplateId: null },
    ]);
    db.effectFinalOutputRun.findMany.mockResolvedValue([run, older]);
    expect((await service.listPath('p', 'child')).map((batch) => batch.templateId))
      .toEqual(['t', 'other-template']);
  });

  it('refreshes an un-exported queue entry from the draft instead of reporting it', async () => {
    const { service, db, run, variant } = await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    variant.offsets.s = 1;
    const result = await service.syncFromDraft('p', 'w');
    expect(result).toEqual({ refreshed: [{ templateId: 't', itemCount: 1 }] });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-0' },
        data: expect.objectContaining({ status: 'PENDING_RENDER', progress: 0, errorMessage: null }),
      }),
    );
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
  });

  it('leaves an exported version untouched and marks only its changed film', async () => {
    const { service, db, variant } = await localUpdateHarness();
    variant.offsets.s = 1;
    const result = await service.syncFromDraft('p', 'w');
    expect(result).toEqual({ refreshed: [] });
    const listed = await service.listPath('p', 'w');
    expect(listed[0]?.items[0]?.stale).toBe(true);
    expect(listed[0]?.counts.stale).toBe(1);
    // An exported film may already be delivered, so the user decides when to re-render it.
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });

  it('does not silently rewrite even a pending item once the branch has an output version', async () => {
    const { service, db, run, variant } = await localUpdateHarness();
    run.status = 'PENDING_RENDER';
    variant.offsets.s = 1;
    expect(await service.syncFromDraft('p', 'w')).toEqual({ refreshed: [] });
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });

  it('silently follows edited narration and music before an output version exists', async () => {
    const { service, db, run, rows } = await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    rows[0]!.checkpoint.music.volume = 0.2;
    expect(await service.syncFromDraft('p', 'w')).toEqual({
      refreshed: [{ templateId: 't', itemCount: 1 }],
    });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ snapshot: expect.objectContaining({
        packaging: expect.objectContaining({ music: expect.objectContaining({ volume: 0.2 }) }),
      }) }),
    }));
  });

  it('drops a queued film whose variant left the draft', async () => {
    const { service, db, workspace, run } = await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    workspace.draft!.templates[0]!.workspace.variants = [];
    const result = await service.syncFromDraft('p', 'w');
    expect(result).toEqual({ refreshed: [] });
    expect(db.effectFinalOutputItem.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 'p', id: 'item-0', status: 'PENDING_RENDER' },
    });
  });

  it('rejects a late sync for an older draft revision without touching the queue', async () => {
    const { service, db, run } = await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    db.workflowRun.findFirst.mockResolvedValue({ id: 'w' });
    db.workflowNodeState.findUnique.mockResolvedValue({ revision: 3 });
    const result = await service.syncFromDraft('p', 'w',
      { templateId: 't', expectedDraftRevision: 2 });
    expect(result).toEqual({ refreshed: [], superseded: true });
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });

  it('skips expensive queue synchronization for a delivered template but still reads exact draft differences', async () => {
    const { service, db, mix, working, variant } = await localUpdateHarness();
    db.workflowNodeState.findUnique.mockResolvedValue({ revision: 2 });
    variant.offsets.s = 1;
    expect(await service.syncFromDraft('p', 'w', { templateId: 't', expectedDraftRevision: 2 }))
      .toEqual({ refreshed: [] });
    expect(mix.workspace).not.toHaveBeenCalled();
    expect(working.listArtifacts).not.toHaveBeenCalled();
    const listed = await service.listPath('p', 'w');
    expect(listed[0]!.items[0]!.stale).toBe(true);
    expect(mix.workspace).not.toHaveBeenCalled();
    expect(mix.outputSourceWorkspace).toHaveBeenCalledWith('p', 'w');
    expect(working.listArtifacts).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });

  it('keeps old audio attached when a saved visual edit changes the source', async () => {
    const { service, db, mix, run, workspace, variant } = await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    variant.offsets.s = 1;
    db.workflowRun.findFirst.mockResolvedValue({ id: 'w' });
    db.workflowNodeState.findUnique.mockResolvedValue({ revision: 2 });
    db.effectFinalOutputItem.findFirst.mockResolvedValue({ id: 'item-0' });
    // The active draft revision must match both the initial read and the row-locked write.
    mix.workspace.mockResolvedValue({ ...workspace, draftRevision: 2 });
    const result = await service.syncFromDraft('p', 'w',
      { templateId: 't', expectedDraftRevision: 2 });
    expect(result).toEqual({ refreshed: [{ templateId: 't', itemCount: 1 }] });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'item-0' },
      data: expect.objectContaining({ status: 'PENDING_RENDER' }),
    }));
  });
});

describe('local update', () => {
  it('re-renders only the moved films in place, without opening a branch', async () => {
    const { service, db, working, run, items, variant } = await localUpdateHarness();
    variant.offsets.s = 1;
    await service.localUpdate('p', 'out', { itemIds: ['item-0'] });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-0' },
        data: expect.objectContaining({ status: 'QUEUED', progress: 0, errorMessage: null }),
      }),
    );
    // The old file stays pointed at until the new render lands, so the film remains downloadable.
    expect(items[0]!.fileObjectId).toBe('old-file-0');
    expect(run.status).toBe('QUEUED');
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('refuses a batch that is still rendering or was never exported', async () => {
    const queued = await localUpdateHarness();
    queued.run.status = 'RUNNING';
    await expect(queued.service.localUpdate('p', 'out', { itemIds: ['item-0'] })).rejects.toThrow('正在渲染');
    const pending = await localUpdateHarness();
    pending.run.status = 'PENDING_RENDER';
    await expect(pending.service.localUpdate('p', 'out', { itemIds: ['item-0'] })).rejects.toThrow('尚未导出');
  });
  it('refuses unchanged films and a non-active branch without creating a paid task', async () => {
    const unchanged = await localUpdateHarness();
    await expect(unchanged.service.localUpdate('p', 'out', { itemIds: ['item-0'] }))
      .rejects.toThrow('无需局部更新');
    expect(unchanged.db.jobOutbox.upsert).not.toHaveBeenCalled();
    const oldBranch = await localUpdateHarness();
    oldBranch.variant.offsets.s = 1;
    oldBranch.db.workflowRun.findFirst.mockResolvedValue(null);
    await expect(oldBranch.service.localUpdate('p', 'out', { itemIds: ['item-0'] }))
      .rejects.toThrow('当前活动成片分支');
    expect(oldBranch.db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('marks a changed soundtrack and re-renders it in the same output branch', async () => {
    const { service, db, rows, working } = await localUpdateHarness();
    rows[0]!.checkpoint.music.volume = 0.2;
    const listed = await service.listPath('p', 'w');
    expect(listed[0]?.items[0]?.stale).toBe(true);
    await service.localUpdate('p', 'out', { itemIds: ['item-0'] });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ snapshot: expect.objectContaining({
        packaging: expect.objectContaining({ music: expect.objectContaining({ volume: 0.2 }) }),
      }) }),
    }));
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('refreshes the consumed artifact revisions when a film is locally updated', async () => {
    const { service, artifacts, items } = await localUpdateHarness();
    const snapshot = (items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot;
    const source = artifacts.find((artifact) => artifact.id === snapshot.dependencies[0]?.artifactId)!;
    source.revision += 1;
    source.contentHash = 'new-confirmed-timeline';
    await service.localUpdate('p', 'out', { itemIds: ['item-0'] });
    const updated = (items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot;
    expect(updated.dependencies[0]).toMatchObject({
      artifactId: source.id,
      revision: source.revision,
      contentHash: source.contentHash,
    });
  });
  it('reports an unknown item id instead of re-queuing the whole batch', async () => {
    const { service, db } = await localUpdateHarness();
    await expect(service.localUpdate('p', 'out', { itemIds: ['nope'] })).rejects.toThrow(
      '成片条目不存在',
    );
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('tells the user to re-package when the draft no longer holds the film', async () => {
    const gone = await localUpdateHarness();
    gone.workspace.draft!.templates[0]!.workspace.variants = [];
    await expect(gone.service.localUpdate('p', 'out', { itemIds: ['item-0'] })).rejects.toThrow('已不在当前成片工程中');
    // A missing source file is a real rendering error, not a semantic package-expiry decision.
    const broken = await localUpdateHarness();
    broken.workspace.materials = [];
    await expect(broken.service.localUpdate('p', 'out', { itemIds: ['item-0'] })).rejects.toThrow('原素材来源无法确认');
  });
});

/**
 * A delivered batch whose draft has moved on. The snapshot is built by the real packaging callback so
 * a local update faces exactly the shape production hands it.
 */
async function localUpdateHarness(withOutputVersion = true) {
  const context = harness(1);
  // Bind the harness's own variant in place: the package froze it, and the draft the callback reads
  // has to be the very same object for the confirmation to still match.
  const variant = context.rows[0]!.snapshot.variant;
  variant.bindings = { s: 'clip' };
  variant.bindingRevisions = { s: 1 };
  variant.offsets = { s: 0 };
  context.rows[0]!.sourceTimelineHash = visualHash(variant);
  const workspace = {
    materials: [
      {
        id: 'clip',
        artifactId: 'clip-artifact',
        fileObjectId: 'video',
        duration: 12,
        available: true,
        artifactRevision: 1,
        contentHash: 'clip-hash',
      },
    ],
    draft: {
      templates: [{ id: 't', workspace: { template: { name: '模板' }, variants: [variant] } }],
    },
  };
  context.mix.workspace.mockResolvedValue(workspace as never);
  await context.service.upsertFromPackaging('p', 'w', 't');
  const items = context.outputRun.items as {
    id: string;
    status: string;
    fileObjectId?: string | null;
    assetId?: string | null;
  }[];
  items.forEach((item, index) => {
    item.id = `item-${index}`;
    item.status = 'COMPLETED';
    item.fileObjectId = `old-file-${index}`;
    item.assetId = `old-asset-${index}`;
  });
  context.db.effectFinalOutputItem.findUniqueOrThrow.mockImplementation(({ where }) =>
    Promise.resolve(items.find((item) => item.id === where.id)));
  context.outputRun.status = 'COMPLETED';
  context.db.workflowRun.findFirst.mockResolvedValue({ id: 'w' });
  // The artifacts a rebuilt clip needs: the clip itself and the Prompt it was cut from.
  const artifacts = [
    {
      id: 'clip-artifact',
      artifactKey: 'render-clip:c',
      revision: 1,
      contentHash: 'clip-hash',
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      payload: { promptId: 'pr' },
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'pr', sourceRevision: 1 }],
    },
    {
      id: 'pr',
      artifactKey: 'prompt-batch:pr',
      revision: 1,
      contentHash: 'prompt-hash',
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      payload: { items: [{ id: 'pr', content: '原始 Prompt' }] },
      dependencies: [],
    },
    ...((items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot.dependencies ?? []).map((dependency) => ({
      id: dependency.artifactId,
      artifactKey: dependency.artifactId,
      nodeId: 'TEMPLATE_MIX',
      revision: dependency.revision,
      contentHash: dependency.contentHash,
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      dependencies: [],
    })),
    ...(withOutputVersion ? [{
      id: 'delivery', artifactKey: 'final-delivery:t', nodeId: 'FINAL_OUTPUT',
      revision: 1, contentHash: 'delivery-hash', freshness: 'CURRENT',
      availability: 'AVAILABLE', dependencies: [],
    }] : []),
  ];
  context.db.workingArtifact.findMany.mockResolvedValue(artifacts);
  context.mix.outputSourceWorkspace.mockResolvedValue({ ...workspace, artifacts } as never);
  // The workbench exit reads through the repository, the local update through the transaction client.
  context.working.listArtifacts.mockResolvedValue(artifacts);
  // The minimal packaging fixture above freezes only a file id. Make this exported baseline match
  // the real clip structure so an untouched draft is not spuriously reported as changed.
  const baseline = items[0] as unknown as { snapshot: FinalOutputSnapshot };
  baseline.snapshot.timeline.clips = (context.service as unknown as {
    liveClips: (variant: EffectTemplateMixVariant, materials: unknown[], artifacts: unknown[]) =>
      PackagingSnapshot['clips'];
  }).liveClips(variant, workspace.materials, artifacts);
  const run = context.outputRun;
  context.db.effectFinalOutputRun.findMany.mockResolvedValue([run]);
  // The queueing above is the fixture, not the behaviour under test, so the call log starts empty.
  vi.clearAllMocks();
  return { ...context, items, run, workspace, variant, artifacts };
}
