import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        slots: [{ id: 's', role: 'PRODUCT', label: '产品', duration: 10, transition: '硬切' }],
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
  const db = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    workflowNodeState: { findUnique: vi.fn().mockResolvedValue(state) },
    workingArtifact: { findMany: vi.fn().mockResolvedValue(sources) },
    fileObject: {
      findMany: vi.fn().mockResolvedValue(files),
      count: vi.fn().mockResolvedValue(3),
      create: vi.fn().mockResolvedValue({ id: 'new-file' }),
      delete: vi.fn().mockResolvedValue({ id: 'new-file' }),
    },
    asset: {
      create: vi.fn().mockResolvedValue({ id: 'asset-created' }),
      update: vi.fn().mockImplementation(({ where }) => Promise.resolve({ id: where.id })),
    },
    assetVersion: { create: vi.fn().mockResolvedValue({ id: 'version' }), deleteMany: vi.fn() },
    effectPackagingRun: { count: vi.fn().mockResolvedValue(0) },
    effectPackagingItem: { findMany: vi.fn().mockResolvedValue(rows) },
    effectFinalOutputRun: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(outputRun),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => {
        outputRun.status = data.status;
        outputRun.items = data.items.create;
        return { id: 'out' };
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockImplementation(({ data }) => Object.assign(outputRun, data)),
    },
    effectFinalOutputItem: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn().mockImplementation(({ where, data }) => {
        const item = outputRun.items.find((entry) => (entry as { id: string }).id === where.id) as Record<string, unknown> | undefined;
        if (item) Object.assign(item, data);
        return data;
      }),
    },
    jobOutbox: { upsert: vi.fn() },
    workflowRun: { updateMany: vi.fn() },
    project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'p', name: '项目' }) },
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
          previousStorageKey: null,
          unchanged: false,
          orphanedFileObjectIds: [],
        })),
      ),
    enqueueCleanup: vi.fn(),
  };
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
  );
  return { db, service, working, storage, rows, state, sources, mix, outputRun };
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

describe('atomic full packaging completion', () => {
  it.each([1, 10, 100])(
    'commits all %i visuals and packages as an isolated pending template output',
    async (count) => {
      const { service, db, working, outputRun } = harness(count);
      await service.complete('p', 't', request);
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
    checkpoint.captions = [{ id: 'line', start: 3, end: 4.5, text: '商品' }];
    await edited.service.complete('p', 't', request);
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
    await service.complete('p', 't', request);
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
    await plain.service.complete('p', 't', request);
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

    await service.complete('p', 't', request);
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
  it('rejects reused idempotency keys for different requests', async () => {
    const { service, db } = harness();
    db.effectFinalOutputRun.findUnique.mockResolvedValue({ id: 'out', requestHash: 'other' });
    await expect(service.complete('p', 't', request)).rejects.toThrow('幂等');
  });
  it('freezes resolution and frame rate and enqueues only after explicit export', async () => {
    const { service, db, outputRun } = harness();
    await service.complete('p', 't', request);
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
  it.each(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])(
    're-exports a %s batch by resetting every item and rewriting the batch spec',
    async (status) => {
      const { service, db, outputRun } = harness(3);
      await service.complete('p', 't', request);
      outputRun.status = status;
      const items = outputRun.items as { status: string; snapshot: FinalOutputSnapshot }[];
      items.forEach((item) => { item.status = status; });
      db.workingArtifact.findMany.mockResolvedValue(currentRows(items));

      await service.start('p', 'out', { resolution: '480p', frameRate: 24 });

      expect(db.effectFinalOutputItem.update).toHaveBeenCalledTimes(3);
      for (const [call] of db.effectFinalOutputItem.update.mock.calls) {
        expect(call.data).toMatchObject({ status: 'QUEUED', progress: 0, errorMessage: null });
        expect(call.data.snapshot).toMatchObject({ resolution: '480p', frameRate: 24 });
      }
      expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    },
  );
  it('refuses a re-export when the upstream package went stale, without touching state', async () => {
    const { service, db, outputRun } = harness(2);
    await service.complete('p', 't', request);
    outputRun.status = 'COMPLETED';
    const items = outputRun.items as { status: string; snapshot: FinalOutputSnapshot }[];
    items.forEach((item) => { item.status = 'COMPLETED'; });
    // Bump the package revision: the batch was exported against revision 2.
    db.workingArtifact.findMany.mockResolvedValue(
      currentRows(items).map((row) =>
        row.id.startsWith('timeline-package:') ? { ...row, revision: 9 } : row,
      ),
    );

    await expect(service.start('p', 'out', { resolution: '1080p', frameRate: 50 })).rejects.toThrow('过期');

    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
    expect(outputRun.status).toBe('COMPLETED');
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
  await context.service.complete('p', 't', request);
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
  it('refuses a stale upstream before resetting the item', async () => {
    const { service, db, items } = await exportedRun();
    db.workingArtifact.findMany.mockResolvedValue(currentRows(items).slice(0, 1));
    await expect(service.renderItem('p', 'out', 'item-0')).rejects.toThrow('过期');
    expect(items[0]!.status).toBe('COMPLETED');
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
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
