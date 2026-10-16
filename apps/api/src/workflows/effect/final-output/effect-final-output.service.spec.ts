import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { packagingPictureOnlyVariant } from '@ai-marketing/contracts';
import type {
  EffectTemplateMixVariant,
  FinalOutputSnapshot,
  PackagingCheckpoint,
  PackagingSnapshot,
} from '@ai-marketing/contracts';
import type { PrismaService } from '../../../database/prisma.service';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import { visualHash } from '../template-mix/effect-packaging.domain';
import { EffectFinalOutputService } from './effect-final-output.service';

describe('retained packaging baseline compatibility', () => {
  function fixture() {
    const h = harness();
    const checkpoint = structuredClone(h.rows[0]!.checkpoint);
    const snapshot = {
      unpackaged: false,
      packaging: structuredClone(checkpoint),
      dependencies: [
        {
          artifactId: 'old-visual',
          artifactKey: 'timeline-project:t:v0',
          revision: 2,
          contentHash: 'visual-hash',
        },
        { artifactId: 'old-package', revision: 3, contentHash: 'package-hash' },
      ],
    };
    const item = { projectId: 'p', runId: 'out', variantId: 'v0', snapshot };
    const rows = [
      {
        id: 'old-visual',
        projectId: 'p',
        workflowRunId: 'parent',
        nodeId: 'TEMPLATE_MIX',
        artifactKey: 'timeline-project:t:v0',
        revision: 2,
        contentHash: 'visual-hash',
        availability: 'AVAILABLE',
        freshness: 'CURRENT',
      },
      {
        id: 'old-package',
        projectId: 'p',
        workflowRunId: 'parent',
        nodeId: 'TEMPLATE_MIX',
        artifactKey: 'timeline-package:t:v0',
        revision: 3,
        contentHash: 'package-hash',
        availability: 'AVAILABLE',
        freshness: 'CURRENT',
      },
    ];
    h.db.workflowRun.findMany.mockResolvedValue([
      { id: 'w', parentWorkflowRunId: 'parent', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 't' },
      { id: 'parent', parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null },
    ]);
    const findFailed = vi.fn().mockResolvedValue({ id: 'failed-batch-item' });
    Object.assign(h.db.effectPackagingItem, { findFirst: findFailed });
    h.db.workingArtifact.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.projectId === where.projectId &&
            where.workflowRunId.in.includes(row.workflowRunId) &&
            row.nodeId === where.nodeId &&
            where.id.in.includes(row.id) &&
            where.artifactKey.in.includes(row.artifactKey) &&
            row.availability === where.availability,
        ),
      ),
    );
    const internal = h.service as unknown as {
      retainedPackagingArtifacts: (...args: unknown[]) => Promise<typeof rows>;
      rewriteFilm: (...args: unknown[]) => Promise<void>;
      liveClips: (...args: unknown[]) => unknown;
    };
    return {
      ...h,
      internal,
      item,
      checkpoint,
      baseline: rows,
      findFailed,
      resolve: (artifacts: unknown[] = []) =>
        internal.retainedPackagingArtifacts(h.db, 't', item, checkpoint, artifacts),
    };
  }

  it('loads only exact frozen ancestor references for a failed repackaging film without writing or queuing', async () => {
    const h = fixture();
    expect(await h.resolve()).toEqual(h.baseline);
    expect(h.findFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'p',
          variantId: 'v0',
          status: { in: ['FAILED', 'CANCELLED'] },
          run: { workflowRunId: 'w', templateId: 't' },
          snapshot: { path: ['operation'], equals: 'BATCH_PACKAGE' },
        },
      }),
    );
    expect(h.db.effectFinalOutputItem.update).not.toHaveBeenCalled();
    expect(h.db.jobOutbox.upsert).not.toHaveBeenCalled();
    expect(h.working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
  });

  it('allows the normal film rewrite with its preserved package and does not change the ancestor', async () => {
    const h = fixture();
    const before = structuredClone(h.baseline);
    const variant = h.rows[0]!.snapshot.variant;
    Object.assign(h.item.snapshot, {
      timeline: { variant, duration: 10, dependencies: [] },
      aspectRatio: '3:4',
      resolution: '720p',
      frameRate: 30,
    });
    vi.spyOn(h.internal, 'liveClips').mockReturnValue([
      { slotId: 's', start: 0, duration: 10, fileObjectId: 'video' },
    ]);
    await h.internal.rewriteFilm(
      h.db,
      't',
      h.item,
      variant,
      { materials: [] },
      [],
      'PENDING_RENDER',
      h.checkpoint,
    );
    expect(h.db.effectFinalOutputItem.update).toHaveBeenCalledOnce();
    expect(h.db.effectFinalOutputItem.update.mock.calls[0]![0].data.snapshot.packaging).toEqual(
      h.checkpoint,
    );
    expect(h.baseline).toEqual(before);
    expect(h.db.jobOutbox.upsert).not.toHaveBeenCalled();
  });

  it.each(['revision', 'hash', 'project', 'sibling', 'template', 'variant', 'unavailable'])(
    'does not admit a mismatched retained package: %s',
    async (invalid) => {
      const h = fixture();
      const row = h.baseline[1]!;
      if (invalid === 'revision') row.revision++;
      if (invalid === 'hash') row.contentHash = 'changed';
      if (invalid === 'project') row.projectId = 'other';
      if (invalid === 'sibling') row.workflowRunId = 'sibling';
      if (invalid === 'template') row.artifactKey = 'timeline-package:other:v0';
      if (invalid === 'variant') row.artifactKey = 'timeline-package:t:other';
      if (invalid === 'unavailable') row.availability = 'MISSING';
      expect((await h.resolve()).some((artifact) => artifact.id === 'old-package')).toBe(false);
    },
  );

  it('never falls back over an unavailable current package or an unconfirmed package', async () => {
    const h = fixture();
    expect(
      await h.resolve([{ artifactKey: 'timeline-package:t:v0', availability: 'MISSING' }]),
    ).toEqual([]);
    h.findFailed.mockResolvedValue(null);
    expect(await h.resolve()).toEqual([]);
  });

  it('requires the unchanged retained checkpoint, ignoring only transient supplier task fields', async () => {
    const h = fixture();
    Object.assign(h.checkpoint, { musicTaskId: 'old-task', musicSubmissionPending: true });
    expect(await h.resolve()).toHaveLength(2);
    h.checkpoint.voices.line!.fileObjectId = 'unconfirmed-new-voice';
    expect(await h.resolve()).toEqual([]);
  });
});

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
    {
      id: 'pr',
      revision: 1,
      contentHash: 'prompt-hash',
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      artifactKey: 'prompt-batch:pr',
      payload: { items: [{ id: 'pr', content: '已确认原始 Prompt' }] },
      dependencies: [],
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
  const state = {
    id: 'node',
    revision: 1,
    state: { templates: [{ id: 't', workspace: { editVersion: 1, variants } }] },
  };
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
    workflowNodeState: { findUnique: vi.fn().mockResolvedValue(state), update: vi.fn() },
    workingArtifact: {
      findMany: vi.fn().mockResolvedValue(sources),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    fileObject: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }: { where?: { id?: { in?: string[] } } }) =>
          Promise.resolve(
            where?.id?.in ? files.filter((file) => where.id!.in!.includes(file.id)) : files,
          ),
        ),
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
    effectTemplateMixAiRun: { findFirst: vi.fn().mockResolvedValue(null) },
    effectPackagingItem: { findMany: vi.fn().mockResolvedValue(rows), update: vi.fn() },
    effectFinalOutputRun: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      // Only the queue lookup filters on PENDING_RENDER; every other caller names a run by id.
      findFirst: vi
        .fn()
        .mockImplementation((args: { where?: { status?: unknown } }) =>
          Promise.resolve(
            args?.where?.status === 'PENDING_RENDER'
              ? pending.current
              : typeof args?.where?.status === 'object'
                ? (pending.current ?? outputRun)
                : outputRun,
          ),
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
      findUniqueOrThrow: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            outputRun.items.find((entry) => (entry as { id: string }).id === where.id),
          ),
        ),
      update: vi.fn().mockImplementation(({ where, data }) => {
        const item = outputRun.items.find((entry) => (entry as { id: string }).id === where.id) as
          Record<string, unknown> | undefined;
        if (item) Object.assign(item, data);
        return data;
      }),
    },
    jobOutbox: { upsert: vi.fn() },
    workflowRun: {
      updateMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ id: 'w' }),
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'w', parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null },
        ]),
    },
    project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'p', name: '项目' }) },
  };
  const inputs = variants.map((v) => ({ artifactKey: `timeline-project:t:${v.id}`, input: {} }));
  const mix = {
    outputSourceWorkspace: vi.fn().mockResolvedValue({
      draft: {
        templates: [
          {
            id: 't',
            workspace: {
              template: { name: '模板' },
              variants,
            },
          },
        ],
      },
      materials: [
        {
          id: 'clip',
          artifactId: 'source',
          fileObjectId: 'video',
          duration: 12,
          available: true,
          artifactRevision: 1,
          contentHash: 'hash',
          ratio: '3:4',
        },
      ],
    }),
    prepareValidation: vi.fn().mockResolvedValue({ variants, inputs }),
    workspace: vi.fn().mockResolvedValue({
      materials: [
        {
          id: 'clip',
          artifactId: 'source',
          fileObjectId: 'video',
          duration: 12,
          available: true,
          artifactRevision: 1,
          contentHash: 'hash',
          ratio: '3:4',
        },
      ],
    }),
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
    // Individual tests which exercise a full re-export install an independent child below.
    beginEffectNodeEdit: vi.fn().mockResolvedValue({
      runId: 'w',
      parentWorkflowRunId: null,
      productIdMap: {},
      taskIdMap: {},
      created: false,
    }),
    publishEffectNodeEdit: vi.fn(),
  };
  db.workingArtifact.findMany.mockResolvedValue([
    ...sources,
    ...variants.map((variant) => ({
      id: `timeline-package:t:${variant.id}`,
      artifactKey: `timeline-package:t:${variant.id}`,
      revision: 2,
      contentHash: 'confirmed-hash',
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      payload: {},
      dependencies: [],
    })),
  ]);
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
    {
      getEffectBranchTree: vi.fn().mockResolvedValue({
        activeWorkflowRunId: 'w',
        branches: [
          {
            workflowRunId: 'w',
            parentWorkflowRunId: null,
            forkNodeId: null,
            forkTemplateId: null,
            createdAt: '2026-10-04T00:00:00Z',
            templates: [{ templateId: 't' }],
          },
        ],
      }),
    } as unknown as WorkflowWorkingService,
  );
  return { db, service, working, storage, rows, state, sources, mix, outputRun, pending };
}

/** Full exports clone a pending batch; a completed parent is never that pending child. */
function forkExportHarness(context: ReturnType<typeof harness>) {
  const { db, working, outputRun } = context;
  const child = {
    ...structuredClone(outputRun),
    id: 'child-out',
    workflowRunId: 'child-run',
    status: 'PENDING_RENDER',
    items: outputRun.items.map((item) => ({
      ...structuredClone(item as Record<string, unknown>),
      id: `child-${(item as { id: string }).id}`,
      status: 'PENDING_RENDER',
      fileObjectId: null,
      assetId: null,
    })),
  };
  working.beginEffectNodeEdit.mockResolvedValue({
    runId: 'child-run',
    parentWorkflowRunId: 'w',
    productIdMap: {},
    taskIdMap: {},
    created: true,
  });
  db.effectFinalOutputRun.findFirst.mockImplementation((args) =>
    Promise.resolve(
      args.where?.workflowRunId === 'child-run' || args.where?.id === child.id ? child : outputRun,
    ),
  );
  db.effectFinalOutputRun.update.mockImplementation(({ where, data }) =>
    Object.assign(where.id === child.id ? child : outputRun, data),
  );
  db.effectFinalOutputItem.update.mockImplementation(({ where, data }) => {
    const item = [...outputRun.items, ...child.items].find(
      (entry) => (entry as { id: string }).id === where.id,
    ) as Record<string, unknown> | undefined;
    return item ? Object.assign(item, data) : data;
  });
  db.effectFinalOutputItem.findUniqueOrThrow.mockImplementation(({ where }) =>
    Promise.resolve(
      [...outputRun.items, ...child.items].find((item) => (item as { id: string }).id === where.id),
    ),
  );
  return child;
}

describe('incremental transactional packaging commit', () => {
  it('commits one complete package and removes old non-video tracks without touching a sibling', async () => {
    const { db, service, rows, state, working } = harness(2);
    const target = state.state.templates[0]!.workspace.variants[0]!;
    target.captions = [{ id: 'manual', start: 0, end: 1, text: 'old' }];
    target.originalVolume = 1;
    const sibling = structuredClone(state.state.templates[0]!.workspace.variants[1]);
    rows[0]!.snapshot.operation = 'SINGLE_PACKAGE';
    rows[0]!.snapshot.baselineVariant = structuredClone(target);
    rows[0]!.snapshot.variant = packagingPictureOnlyVariant(target);
    Object.assign(rows[0]!, { status: 'RUNNING', stage: 'READY' });
    db.effectPackagingRun.count.mockResolvedValue(1);
    await service.upsertFromPackaging('p', 'w', 't', {
      publish: false,
      onlyVariantIds: ['v0'],
      packagingRunId: 'pack',
      attemptToken: 'token',
    });
    expect(db.workflowNodeState.update).toHaveBeenCalledOnce();
    expect(state.state.templates[0]!.workspace.variants[0]).toMatchObject({
      captions: [],
      originalVolume: 0,
    });
    expect(state.state.templates[0]!.workspace.variants[1]).toEqual(sibling);
    expect(db.effectPackagingItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-v0' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('never replaces the baseline on a failed new-protocol item', async () => {
    const { service, rows, state, db } = harness();
    rows[0]!.snapshot.operation = 'SINGLE_PACKAGE';
    rows[0]!.status = 'FAILED';
    const baseline = structuredClone(state);
    await expect(service.upsertFromPackaging('p', 'w', 't')).rejects.toThrow('保留包装前原样');
    expect(state).toEqual(baseline);
    expect(db.workflowNodeState.update).not.toHaveBeenCalled();
  });
});

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
        {
          id: 'earlier-on-timeline',
          role: 'PRODUCT',
          label: '产品',
          duration: 7,
          transition: '硬切',
        },
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
    outputRun.items = [
      {
        id: 'output-item',
        variantId: 'v0',
        name: '成片0',
        status: 'PENDING_RENDER',
        progress: 0,
        errorMessage: null,
        fileObjectId: null,
        assetId: null,
        snapshot,
      },
    ];

    const result = await service.get('p', 'out');

    expect(result.items[0]?.cover).toEqual({
      fileObjectId: 'template-card-cover',
      time: 0.12,
      contentHash: 'template-card-hash',
    });
  });
});

describe('atomic workbench source update preparation', () => {
  const body = {
    workflowRunId: 'w',
    templateId: 't',
    expectedDraftRevision: 1,
    variantIds: ['v0'],
  };
  function preparation(freshness: 'CURRENT' | 'STALE' = 'STALE') {
    const h = harness();
    const variant = h.state.state.templates[0]!.workspace.variants[0]!;
    (h.state.state.templates[0]!.workspace as unknown as { template: unknown }).template = {
      name: '测试模板',
      editVersion: 1,
      slots: variant.slots,
    };
    h.mix.workspace.mockResolvedValue({
      draft: h.state.state,
      materials: [
        {
          id: 'clip',
          artifactId: 'source',
          fileObjectId: 'video',
          duration: 12,
          available: true,
          artifactRevision: 2,
          contentHash: 'new',
          ratio: '3:4',
        },
      ],
    } as never);
    h.db.workingArtifact.findMany.mockResolvedValue([
      ...h.sources,
      {
        id: 'visual',
        nodeId: 'TEMPLATE_MIX',
        artifactKey: 'timeline-project:t:v0',
        revision: 1,
        freshness,
        availability: 'AVAILABLE',
        contentHash: 'confirmed',
        payload: { variant },
        dependencies: [],
      },
    ] as never);
    h.db.effectFinalOutputRun.findFirst.mockResolvedValue(null);
    h.db.effectFinalOutputRun.create.mockImplementation(({ data }) => {
      Object.assign(h.outputRun, {
        ...data,
        id: 'repaired',
        items: data.items.create.map((item: Record<string, unknown>, i: number) => ({
          ...item,
          id: `new-${i}`,
        })),
      });
      return Promise.resolve(h.outputRun);
    });
    const internals = h.service as unknown as {
      queueLocalUpdate: (...args: unknown[]) => Promise<void>;
    };
    const queue = vi.spyOn(internals, 'queueLocalUpdate').mockResolvedValue();
    vi.spyOn(h.service, 'get').mockResolvedValue({ id: 'repaired' } as never);
    return { ...h, queue };
  }
  it.each(['CURRENT', 'STALE'] as const)(
    'recovers confirmed %s projects without validating obsolete bindings',
    async (freshness) => {
      const h = preparation(freshness);
      await h.service.updateSourceProjects('p', body);
      expect(h.mix.prepareValidation).not.toHaveBeenCalled();
      expect(h.db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
      expect(h.queue).toHaveBeenCalledWith(
        expect.anything(),
        'p',
        'repaired',
        { itemIds: ['new-0'] },
        false,
        true,
        expect.objectContaining({
          workspace: expect.objectContaining({ draft: h.state.state }),
          artifacts: h.sources,
        }),
      );
      expect(h.working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
    },
  );
  it('rejects a changed confirmation signature before creating a task', async () => {
    const h = preparation();
    await expect(
      h.service.updateSourceProjects('p', { ...body, expectedSourceSignature: 'old-difference' }),
    ).rejects.toThrow('待更新范围已变化');
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
  });
  it('persists the complete affected source scope for refresh after individual films finish', async () => {
    const h = preparation();
    h.db.effectFinalOutputItem.findMany.mockImplementation(async () => h.outputRun.items);
    await h.service.updateSourceProjects('p', body);
    expect(h.outputRun.items[0]).toMatchObject({
      snapshot: {
        sourceOperation: { affectedVariantIds: ['v0'] },
      },
    });
  });
  it.each([null, 'QUEUED', 'RUNNING'])(
    'does not overlap an unfinished frozen APPEND continuation (%s)',
    async (status) => {
      const h = preparation();
      Object.assign(h.outputRun, {
        status: 'PENDING_RENDER',
        items: [
          {
            id: 'old',
            variantId: 'v0',
            snapshot: { sourceOperation: { id: 'previous-operation', addedMaterialIds: ['clip'] } },
          },
        ],
      });
      h.db.effectFinalOutputRun.findFirst.mockResolvedValue(h.outputRun);
      h.db.effectTemplateMixAiRun.findFirst.mockImplementation(async ({ where }) =>
        where.inputSnapshot ? (status ? { status } : null) : null,
      );
      await expect(h.service.updateSourceProjects('p', body)).rejects.toThrow('上一轮局部更新');
      expect(h.queue).not.toHaveBeenCalled();
    },
  );
  it.each(['FAILED', 'CANCELLED'])(
    'allows a fresh net-difference confirmation after APPEND %s',
    async (status) => {
      const h = preparation();
      Object.assign(h.outputRun, {
        status: 'PENDING_RENDER',
        items: [
          {
            id: 'old',
            variantId: 'v0',
            snapshot: {
              sourceOperation: { id: 'previous-operation', addedMaterialIds: ['old-addition'] },
            },
          },
        ],
      });
      h.db.effectFinalOutputRun.findFirst.mockResolvedValue(h.outputRun);
      h.db.effectTemplateMixAiRun.findFirst.mockImplementation(async ({ where }) =>
        where.inputSnapshot ? { status } : null,
      );
      await expect(
        h.service.updateSourceProjects('p', { ...body, operationId: 'new-confirmation' }),
      ).resolves.toEqual({ id: 'repaired' });
      expect(h.queue).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        'p',
        h.outputRun.id,
        { itemIds: ['old'] },
        false,
        true,
        expect.anything(),
      );
    },
  );
  it('keeps the packaging fence while allowing upstream saves to occur independently', async () => {
    const h = preparation();
    h.db.effectPackagingRun.count.mockResolvedValue(1);
    await expect(h.service.updateSourceProjects('p', body)).rejects.toThrow('包装新增成片');
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
  });
  it('requires reconfirmation when newly added films now require automatic packaging', async () => {
    const h = preparation();
    const workspace = await h.mix.workspace('p', 'w');
    h.mix.workspace.mockResolvedValue({
      ...workspace,
      pendingAddedMaterialIds: { t: ['clip'] },
    } as never);
    Object.assign(h.mix, { hasSuccessfulPackaging: vi.fn().mockResolvedValue(true) });
    await expect(
      h.service.updateSourceProjects('p', {
        ...body,
        appendNewMaterials: true,
        expectedPackageNewVariants: false,
      }),
    ).rejects.toThrow('费用类型已变化');
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
  });
  it('replays the same operation before checking a newer draft and refuses a different confirmation', async () => {
    const h = preparation();
    const request = { ...body, operationId: 'operation-1' };
    h.db.effectFinalOutputItem.findFirst.mockResolvedValue({
      runId: 'repaired',
      snapshot: {
        sourceOperation: { id: request.operationId, confirmationHash: workflowStateHash(request) },
      },
    } as never);
    h.state.revision = 3;
    await expect(h.service.updateSourceProjects('p', request)).resolves.toEqual({ id: 'repaired' });
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    await expect(
      h.service.updateSourceProjects('p', { ...request, expectedDraftRevision: 2 }),
    ).rejects.toThrow('不同确认');
  });
  it('allows a template current path to refresh while a sibling template owns the global active Run', async () => {
    const h = preparation();
    h.db.workflowRun.findFirst.mockResolvedValue({ id: 'other-template-run' } as never);
    vi.mocked(h.service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'other-template-run',
      branches: [
        {
          workflowRunId: 'root',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          createdAt: '0',
          templates: [{ templateId: 't' }, { templateId: 'other' }],
        },
        {
          workflowRunId: 'w',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 't',
          createdAt: '1',
          templates: [{ templateId: 't' }, { templateId: 'other' }],
        },
        {
          workflowRunId: 'other-template-run',
          parentWorkflowRunId: 'w',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'other',
          createdAt: '2',
          templates: [{ templateId: 't' }, { templateId: 'other' }],
        },
      ],
    } as never);

    await expect(h.service.updateSourceProjects('p', body)).resolves.toEqual({ id: 'repaired' });
    expect(h.db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
    expect(h.queue).toHaveBeenCalledWith(
      expect.anything(),
      'p',
      'repaired',
      { itemIds: ['new-0'] },
      false,
      true,
      expect.objectContaining({
        workspace: expect.objectContaining({ draft: h.state.state }),
        artifacts: h.sources,
      }),
    );
  });
  it('prepares a template refresh when no global active Run is visible', async () => {
    const h = preparation();
    h.db.workflowRun.findFirst.mockResolvedValue(null as never);

    await expect(h.service.updateSourceProjects('p', body)).resolves.toEqual({ id: 'repaired' });
    expect(h.db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
    expect(h.queue).toHaveBeenCalledWith(
      expect.anything(),
      'p',
      'repaired',
      { itemIds: ['new-0'] },
      false,
      true,
      expect.objectContaining({
        workspace: expect.objectContaining({ draft: h.state.state }),
        artifacts: h.sources,
      }),
    );
  });
  it('reuses the current branch batch rather than reconciling or overwriting its baseline', async () => {
    const h = preparation();
    h.outputRun.items = [{ id: 'old', variantId: 'v0', snapshot: { userEdited: true } }];
    h.db.effectFinalOutputRun.findFirst.mockResolvedValue(h.outputRun);
    await h.service.updateSourceProjects('p', body);
    expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(h.mix.workspace).toHaveBeenCalledTimes(2); // Freeze and recheck the confirmation's net delta.
    expect(h.queue).toHaveBeenCalledWith(
      expect.anything(),
      'p',
      'out',
      { itemIds: ['old'] },
      false,
      true,
      expect.objectContaining({
        workspace: expect.objectContaining({ draft: h.state.state }),
        artifacts: h.sources,
      }),
    );
    expect(h.outputRun.items[0]).toHaveProperty('snapshot.userEdited', true);
  });
  it.each(['revision', 'unconfirmed', 'missing-member'] as const)(
    'blocks %s before creating a task',
    async (failure) => {
      const h = preparation();
      if (failure === 'revision') h.state.revision = 2;
      if (failure === 'unconfirmed')
        h.db.workingArtifact.findMany.mockResolvedValue(h.sources as never);
      if (failure === 'missing-member') {
        h.outputRun.items = [{ id: 'other', variantId: 'other' }];
        h.db.effectFinalOutputRun.findFirst.mockResolvedValue(h.outputRun);
      }
      await expect(h.service.updateSourceProjects('p', body)).rejects.toThrow();
      expect(h.queue).not.toHaveBeenCalled();
      expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    },
  );
  it('rolls back a newly repaired baseline when current-source validation fails', async () => {
    const h = preparation();
    h.queue.mockRejectedValue(new ConflictException('最新画面素材不可用'));
    await expect(h.service.updateSourceProjects('p', body)).rejects.toThrow('最新画面素材不可用');
    expect(h.outputRun.id).toBe('out');
    expect(h.outputRun.items).toEqual([]);
    expect(h.service.get).not.toHaveBeenCalled();
  });
  it('never downgrades a delivered branch with a missing output batch to picture-only projects', async () => {
    const h = preparation();
    h.db.workingArtifact.findMany.mockResolvedValue([
      {
        artifactKey: 'final-delivery:t',
        nodeId: 'FINAL_OUTPUT',
        availability: 'AVAILABLE',
        freshness: 'CURRENT',
      },
    ] as never);
    await expect(h.service.updateSourceProjects('p', body)).rejects.toThrow('原交付文件已保留');
    expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(h.queue).not.toHaveBeenCalled();
  });
});

describe('frozen source progress projection', () => {
  it.each([undefined, [], ['v0', 'v1']])(
    'keeps the complete target list after a target succeeds: %j',
    async (affectedVariantIds) => {
      const h = harness(3);
      await h.service.upsertFromPackaging('p', 'w', 't');
      for (const entry of h.outputRun.items) {
        const item = entry as { snapshot: FinalOutputSnapshot; status: string; progress: number };
        item.snapshot.sourceOperation = {
          protocol: 'FROZEN_RENDER_V1',
          id: 'operation',
          templateHash: 'template',
          materials: [],
          promptArtifacts: [],
          addedMaterialIds: [],
          packageNewVariants: false,
          facts: [],
          ...(affectedVariantIds ? { affectedVariantIds } : {}),
        };
      }
      const before = await h.service.get('p', 'out');
      const first = h.outputRun.items[0] as { status: string; progress: number };
      Object.assign(first, { status: 'COMPLETED', progress: 100 });
      const after = await h.service.get('p', 'out');
      expect(after.sourceOperationVariantIds).toEqual(affectedVariantIds);
      expect(after.sourceOperationVariantIds).toEqual(before.sourceOperationVariantIds);
    },
  );
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

  it('resolves inherited source heads in the transaction instead of rejecting stale branch copies', async () => {
    const { service, db, sources, outputRun } = harness(2);
    const old = {
      id: 'old-item',
      variantId: 'v0',
      status: 'COMPLETED',
      snapshot: { preserve: true },
    };
    const frozen = structuredClone(old);
    outputRun.status = 'COMPLETED';
    outputRun.items = [old];
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources.map((source) => ({ ...source, freshness: 'STALE' })),
      confirmedVisual('v1'),
    ]);
    const projection = vi
      .spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts')
      .mockResolvedValue([...sources, confirmedVisual('v1')] as never);
    try {
      await service.upsertFromSmartFill('p', 'w', 't', ['v1'], true);
      expect(projection).toHaveBeenCalledWith('p', { workflowRunId: 'w' });
      expect(old).toEqual(frozen);
      expect(db.effectFinalOutputItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ variantId: 'v1' }),
        }),
      );
    } finally {
      projection.mockRestore();
    }
  });

  it('appends to a delivered batch without modifying old IDs, snapshots, assets or files', async () => {
    const { service, db, sources, outputRun } = harness(2);
    const old = {
      id: 'old-item',
      variantId: 'v0',
      name: '旧成片',
      status: 'COMPLETED',
      fileObjectId: 'old-video',
      assetId: 'old-asset',
      snapshot: { userEdited: true },
    };
    const frozen = structuredClone(old);
    outputRun.status = 'COMPLETED';
    outputRun.items = [old];
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources,
      confirmedVisual('v0'),
      confirmedVisual('v1'),
    ]);
    await service.upsertFromSmartFill('p', 'w', 't', ['v1'], true);
    expect(old).toEqual(frozen);
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.delete).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: 'out',
          variantId: 'v1',
          snapshot: expect.objectContaining({ appendOnly: true, appendPackagingRequired: true }),
        }),
      }),
    );
    db.effectFinalOutputItem.findMany.mockResolvedValue([{ variantId: 'v1' }] as never);
    await service.upsertFromSmartFill('p', 'w', 't', ['v1'], true);
    expect(db.effectFinalOutputItem.create).toHaveBeenCalledOnce();
  });

  it.each(['TEMPLATE_MIX', 'SOURCE_IMPORT', 'FINAL_OUTPUT'])(
    'keeps navigation at %s when background packaging synchronizes an output entry',
    async (nodeId) => {
      const h = harness();
      let persistedNodeId = nodeId;
      h.db.workflowRun.updateMany.mockImplementation(async ({ data }) => {
        if (data.currentNodeId) persistedNodeId = data.currentNodeId;
        return { count: 1 };
      });
      await h.service.upsertFromPackaging('p', 'w', 't', {
        publish: false,
        onlyVariantIds: ['v0'],
      });
      expect(persistedNodeId).toBe(nodeId);
      expect(h.working.commitValidatedArtifactsInTransaction).toHaveBeenCalled();
    },
  );

  it('upgrades only the added output entry and commits only its timeline/package', async () => {
    const { service, db, pending, working } = harness(2);
    pending.current = {
      id: 'out',
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
      status: 'PENDING_RENDER',
      createdAt: new Date(),
      items: [
        { id: 'old-item', variantId: 'v0', name: '旧成片', snapshot: { preserve: true } },
        { id: 'new-item', variantId: 'v1', name: '新成片', snapshot: {} },
      ],
    };
    await service.upsertFromPackaging('p', 'w', 't', { publish: false, onlyVariantIds: ['v1'] });
    expect(db.effectFinalOutputItem.update.mock.calls.map(([arg]) => arg.where.id)).toEqual([
      'new-item',
    ]);
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    const committedKeys = working.commitValidatedArtifactsInTransaction.mock.calls.flatMap((call) =>
      call[4].map((input: { artifactKey: string }) => input.artifactKey),
    );
    expect(committedKeys).toContain('timeline-project:t:v1');
    expect(committedKeys).toContain('timeline-package:t:v1');
    expect(committedKeys).not.toContain('timeline-project:t:v0');
    expect(committedKeys).not.toContain('timeline-package:t:v0');
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'exports only appended films without changing delivered entries or opening a branch (packaged=%s)',
    async (packaged) => {
      const { service, db, outputRun, working } = harness(2);
      const old = {
        id: 'old-item',
        variantId: 'v0',
        status: 'COMPLETED',
        fileObjectId: 'old-file',
        assetId: 'old-asset',
        snapshot: { manualEdit: true },
      };
      const added = {
        id: 'new-item',
        variantId: 'v1',
        status: 'PENDING_RENDER',
        snapshot: { appendOnly: true, appendPackagingRequired: packaged },
      };
      const frozen = structuredClone(old);
      outputRun.items = [old, added];
      const internal = service as unknown as {
        startAppendedFilms: (
          projectId: string,
          id: string,
          settings: { resolution: '720p'; frameRate: 30 },
        ) => Promise<void>;
        packagingByVariant: () => Promise<Map<string, unknown>>;
        rewriteFilm: (...args: unknown[]) => Promise<void>;
        current: (...args: unknown[]) => Promise<void>;
        enqueue: (...args: unknown[]) => Promise<void>;
      };
      vi.spyOn(internal, 'packagingByVariant').mockResolvedValue(
        packaged ? new Map([['v1', {}]]) : new Map(),
      );
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
    },
  );

  it('blocks premature encoding when the appended film requires packaging', async () => {
    const { service, outputRun, working } = harness();
    outputRun.items = [
      {
        id: 'new',
        variantId: 'v0',
        status: 'PENDING_RENDER',
        snapshot: { appendOnly: true, appendPackagingRequired: true },
      },
    ];
    const internal = service as unknown as {
      startAppendedFilms: (
        projectId: string,
        id: string,
        settings: { resolution: '720p'; frameRate: 30 },
      ) => Promise<void>;
      packagingByVariant: () => Promise<Map<string, unknown>>;
      rewriteFilm: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(internal, 'packagingByVariant').mockResolvedValue(new Map());
    const rewrite = vi.spyOn(internal, 'rewriteFilm').mockResolvedValue(undefined);
    await expect(
      internal.startAppendedFilms('p', 'out', { resolution: '720p', frameRate: 30 }),
    ).rejects.toThrow('新增包装尚未完成');
    expect(rewrite).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('queues confirmed picture-only timelines without a paid render or package artifact', async () => {
    const { service, db, sources, outputRun, working } = harness(2);
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources,
      confirmedVisual('v0'),
      confirmedVisual('v1'),
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
      variantId: string;
      name: string;
      snapshot: FinalOutputSnapshot;
    };
    pending.current = {
      id: 'queued-out',
      projectId: 'p',
      templateId: 't',
      workflowRunId: 'w',
      status: 'PENDING_RENDER',
      createdAt: new Date(),
      items: [{ id: 'kept', ...first }],
    };

    await service.upsertFromSmartFill('p', 'w', 't');
    expect(db.effectFinalOutputRun.create).toHaveBeenCalledOnce();
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'kept' } }),
    );
    await service.upsertFromPackaging('p', 'w', 't');
    const upgraded = db.effectFinalOutputItem.update.mock.lastCall![0].data
      .snapshot as FinalOutputSnapshot;
    expect(upgraded.unpackaged).toBe(false);
    expect(upgraded.dependencies).toHaveLength(2);
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
  });

  it('does not overwrite a delivered branch or accept a stale draft or missing source', async () => {
    const { service, db, sources } = harness();
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources,
      confirmedVisual('v0'),
      { id: 'delivery', nodeId: 'FINAL_OUTPUT', artifactKey: 'final-delivery:t' },
    ]);
    await service.upsertFromSmartFill('p', 'w', 't');
    expect(db.effectFinalOutputRun.create).not.toHaveBeenCalled();

    db.workingArtifact.findMany.mockResolvedValue([...sources, confirmedVisual('v0')]);
    db.workflowNodeState.findUnique
      .mockResolvedValueOnce({ revision: 1 })
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
      id: 'v0',
      name: '成片0',
      slots: [],
      bindings: {},
      bindingRevisions: {},
      offsets: {},
    } as unknown as EffectTemplateMixVariant;
    outputRun.items = [
      {
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
      },
    ];
    mix.workspace.mockResolvedValue({
      materials: [],
      draft: {
        templates: [{ id: 't', workspace: { template: { name: '模板' }, variants: [variant] } }],
      },
    } as never);
    working.listArtifacts.mockResolvedValue([
      {
        id: 'delivery',
        nodeId: 'FINAL_OUTPUT',
        artifactKey: 'final-delivery:t',
        availability: 'AVAILABLE',
      },
    ]);
    outputRun.status = 'COMPLETED';
    const result = await service.get('p', 'out');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'film-item',
      status: 'COMPLETED',
      currentPackagingReady: true,
      unpackaged: true,
      fileObjectId: 'rendered-file',
    });
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
      .flatMap(
        (call) => call[4] as { artifactKey: string; input: { payload: { duration: number } } }[],
      )
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
      {
        id: 'source',
        revision: 1,
        contentHash: 'hash',
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
        dependencies: [],
      },
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
    expect(
      item.snapshot.timeline.clips.map((clip) => [clip.slotId, clip.overlay, clip.lane]),
    ).toEqual([
      ['s', undefined, 1],
      ['overlay', true, 0],
    ]);
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
    vi.spyOn(
      service as unknown as { draftDiffersFromSnapshot: (...args: unknown[]) => boolean },
      'draftDiffersFromSnapshot',
    ).mockReturnValue(false);
    await service.start('p', 'out', { resolution: '1080p', frameRate: 50 });
    expect(db.effectFinalOutputRun.update).toHaveBeenCalledWith({
      where: { id: 'out' },
      data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null },
    });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'QUEUED',
          snapshot: expect.objectContaining({ resolution: '1080p', frameRate: 50 }),
        }),
      }),
    );
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(outputRun.status).toBe('QUEUED');
    // An in-flight batch is the one thing a re-export must not touch.
    await expect(service.start('p', 'out', { resolution: '480p', frameRate: 24 })).rejects.toThrow(
      '不能修改',
    );
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('rejects a missing active context before creating an export branch or enqueueing', async () => {
    const { service, db, working } = harness();
    db.workflowRun.findFirst.mockResolvedValue(null as never);
    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 })).rejects.toThrow(
      '请先保存或取消当前编辑',
    );
    expect(db.workflowRun.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: 'p',
        workflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        activeKey: 'ACTIVE',
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      select: { id: true, editSessionNodeId: true },
    });
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });

  it('forks the first complete export even when all initial pending films carry append markers', async () => {
    const h = harness();
    await h.service.upsertFromPackaging('p', 'w', 't');
    h.outputRun.items.forEach((item) => {
      (item as { snapshot: FinalOutputSnapshot }).snapshot.appendOnly = true;
    });
    const child = forkExportHarness(h);
    await h.service.start('p', 'out', { resolution: '480p', frameRate: 24 });
    expect(h.working.beginEffectNodeEdit).toHaveBeenCalledWith(
      'p',
      'w',
      'FINAL_OUTPUT',
      'BATCH',
      expect.objectContaining({ always: true, keepParentActive: true, templateId: 't' }),
    );
    expect(child.status).toBe('QUEUED');
    expect(h.outputRun.status).toBe('PENDING_RENDER');
    expect(
      h.outputRun.items.every((item) => (item as { status: string }).status === 'PENDING_RENDER'),
    ).toBe(true);
  });
  it('looks up the selected batch within the project before any export mutation', async () => {
    const { service, db, working } = harness();
    db.effectFinalOutputRun.findFirst.mockResolvedValue(null);
    await expect(
      service.start('another-project', 'out', { resolution: '720p', frameRate: 30 }),
    ).rejects.toThrow('成片输出任务不存在');
    expect(db.effectFinalOutputRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'another-project', id: 'out' },
      }),
    );
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('allows the user to export a package snapshot after editing the draft', async () => {
    const { service, db, working } = harness();
    await service.upsertFromPackaging('p', 'w', 't');
    vi.spyOn(
      service as unknown as { draftDiffersFromSnapshot: (...args: unknown[]) => boolean },
      'draftDiffersFromSnapshot',
    ).mockReturnValue(true);
    await expect(
      service.start('p', 'out', { resolution: '720p', frameRate: 30 }),
    ).resolves.toBeDefined();
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH', {
      always: true,
      keepParentActive: true,
      templateId: 't',
      templateScopeActiveRunId: 'w',
    });
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it.each(['draft', 'other-template', 'unavailable', 'empty-placeholder'])(
    'exports confirmed films without adopting or being blocked by an extra %s',
    async (extra) => {
      const context = harness(2);
      const { service, db, outputRun, mix, sources, working } = context;
      await service.upsertFromPackaging('p', 'w', 't');
      const workspace = await mix.outputSourceWorkspace('p', 'w');
      const draft = structuredClone(workspace.draft.templates[0]!.workspace.variants[0]!);
      draft.id = 'unsubmitted';
      if (extra === 'empty-placeholder') draft.bindings = {};
      workspace.draft.templates[0]!.workspace.variants.push(draft);
      const artifacts = [
        ...sources,
        ...currentRows(outputRun.items as { snapshot: FinalOutputSnapshot }[]),
      ];
      if (extra === 'other-template' || extra === 'unavailable')
        artifacts.push({
          id: 'unsubmitted-artifact',
          nodeId: 'TEMPLATE_MIX',
          artifactKey: `timeline-project:${extra === 'other-template' ? 'other' : 't'}:unsubmitted`,
          revision: 1,
          contentHash: 'hash',
          freshness: 'CURRENT',
          availability: extra === 'unavailable' ? 'MISSING' : 'AVAILABLE',
        });
      db.workingArtifact.findMany.mockResolvedValue(artifacts);
      const parent = structuredClone(outputRun);
      const child = forkExportHarness(context);
      vi.clearAllMocks();

      await service.start('p', 'out', { resolution: '720p', frameRate: 30 });

      expect(child.status).toBe('QUEUED');
      expect(db.effectFinalOutputItem.update).toHaveBeenCalledTimes(2);
      expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
      expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
      expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
      expect(outputRun).toEqual(parent);
      expect(workspace.draft.templates[0]!.workspace.variants).toHaveLength(3);
    },
  );
  it('still rejects an extra confirmed timeline rather than silently omitting its film', async () => {
    const context = harness();
    const { service, db, outputRun, mix, sources } = context;
    await service.upsertFromPackaging('p', 'w', 't');
    const workspace = await mix.outputSourceWorkspace('p', 'w');
    const variant = {
      ...structuredClone(workspace.draft.templates[0]!.workspace.variants[0]!),
      id: 'new-film',
    };
    workspace.draft.templates[0]!.workspace.variants.push(variant);
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources,
      ...currentRows(outputRun.items as { snapshot: FinalOutputSnapshot }[]),
      {
        id: 'new-timeline',
        nodeId: 'TEMPLATE_MIX',
        artifactKey: 'timeline-project:t:new-film',
        revision: 1,
        contentHash: 'hash',
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      },
    ]);
    forkExportHarness(context);
    vi.clearAllMocks();

    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 })).rejects.toThrow(
      '当前成片工程数量已变化',
    );
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it.each(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'])(
    're-exports a %s batch in an independent child with every item and the new batch spec',
    async (status) => {
      const context = harness(3);
      const { service, db, outputRun, sources } = context;
      await service.upsertFromPackaging('p', 'w', 't');
      outputRun.status = status;
      const items = outputRun.items as { status: string; snapshot: FinalOutputSnapshot }[];
      items.forEach((item) => {
        item.status = status;
      });
      db.workingArtifact.findMany.mockResolvedValue([...sources, ...currentRows(items)]);
      // Keep the source delivery intact while the cloned batch is prepared.
      const parent = structuredClone(outputRun);
      const child = forkExportHarness(context);

      await service.start('p', 'out', { resolution: '480p', frameRate: 24 });

      expect(db.effectFinalOutputItem.update).toHaveBeenCalledTimes(3);
      for (const [call] of db.effectFinalOutputItem.update.mock.calls) {
        expect(call.data).toMatchObject({ status: 'QUEUED', progress: 0, errorMessage: null });
        expect(call.data.snapshot).toMatchObject({ resolution: '480p', frameRate: 24 });
      }
      expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
      expect(outputRun).toEqual(parent);
      expect(child.status).toBe('QUEUED');
    },
  );
  it('allows re-exporting the frozen film after its upstream package went stale', async () => {
    const context = harness(2);
    const { service, db, outputRun, sources } = context;
    await service.upsertFromPackaging('p', 'w', 't');
    outputRun.status = 'COMPLETED';
    const items = outputRun.items as { status: string; snapshot: FinalOutputSnapshot }[];
    items.forEach((item) => {
      item.status = 'COMPLETED';
    });
    // Bump the package revision: the batch was exported against revision 2.
    db.workingArtifact.findMany.mockResolvedValue(
      [...sources, ...currentRows(items)].map((row) =>
        row.id.startsWith('timeline-package:') ? { ...row, revision: 9 } : row,
      ),
    );

    const parent = structuredClone(outputRun);
    const child = forkExportHarness(context);
    await service.start('p', 'out', { resolution: '1080p', frameRate: 50 });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalled();
    expect(db.jobOutbox.upsert).toHaveBeenCalled();
    expect(child.status).toBe('QUEUED');
    expect(outputRun).toEqual(parent);
  });
  it('exports inside the forked child Run once a published version is protected', async () => {
    const context = harness();
    const { service, db, working, outputRun, sources } = context;
    await service.upsertFromPackaging('p', 'w', 't');
    outputRun.status = 'COMPLETED';
    db.workingArtifact.findMany.mockResolvedValue([
      ...sources,
      ...currentRows(outputRun.items as { snapshot: FinalOutputSnapshot }[]),
    ]);
    forkExportHarness(context);

    await service.start('p', 'out', { resolution: '1080p', frameRate: 50 });

    // `always` is what makes an export branch even when it is the project's first one.
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH', {
      always: true,
      keepParentActive: true,
      templateId: 't',
      templateScopeActiveRunId: 'w',
    });
    expect(db.effectFinalOutputRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'child-out' },
      }),
    );
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
  it.each([null, 'source'])(
    'first packaging does not republish the existing Run (parent=%s)',
    async (parentWorkflowRunId) => {
      const { service, db, working } = harness();
      db.workflowRun.findFirst.mockResolvedValue({
        parentWorkflowRunId,
        branchPublishedAt: parentWorkflowRunId ? new Date('2026-10-12') : null,
        editSessionNodeId: null,
        forkNodeId: parentWorkflowRunId ? 'TEMPLATE_MIX' : null,
      });
      await service.publishMixBranch('p', 'w');
      expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
    },
  );
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

describe('canvas and spatial transform output', () => {
  it('freezes the current physical transform, not the old packaging picture', async () => {
    const { service, state, mix, outputRun } = harness();
    const variant = state.state.templates[0]!.workspace.variants[0]!;
    variant.canvasRatio = '2.35:1';
    variant.videoTransforms = {
      s: { x: 0.2, y: -0.1, scaleX: 0.7, scaleY: 0.7, rotation: 20, uniform: true },
    };
    const workspace = await mix.workspace('p', 'w');
    mix.workspace.mockResolvedValue({ ...workspace, renderAspectRatio: 'adaptive' } as never);
    await service.upsertFromPackaging('p', 'w', 't');
    const snapshot = (outputRun.items[0] as { snapshot: FinalOutputSnapshot }).snapshot;
    expect(snapshot.aspectRatio).toBe('2.35:1');
    expect(snapshot.timeline.clips[0]!.transform).toEqual(variant.videoTransforms.s);
    expect(snapshot.packaging.voices?.line?.fileObjectId).toBe('voice');
  });

  it('exports the user canvas override instead of the render default', async () => {
    const { service, state, mix, outputRun } = harness();
    state.state.templates[0]!.workspace.variants[0]!.canvasRatio = '1:1';
    const workspace = await mix.workspace('p', 'w');
    mix.workspace.mockResolvedValue({ ...workspace, renderAspectRatio: '16:9' } as never);
    await service.upsertFromPackaging('p', 'w', 't');
    expect((outputRun.items[0] as { snapshot: FinalOutputSnapshot }).snapshot.aspectRatio).toBe(
      '1:1',
    );
  });

  it('marks a spatial edit stale but explicit identity and UI-only uniform settings stay current', async () => {
    const { service, variant } = await localUpdateHarness();
    const identity = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, uniform: false };
    variant.videoTransforms = { s: identity };
    expect((await service.listPath('p', 'w'))[0]!.items[0]!.stale).toBe(false);
    variant.videoTransforms.s = { ...identity, x: 0.1 };
    expect((await service.listPath('p', 'w'))[0]!.items[0]!.stale).toBe(true);
    variant.videoTransforms.s = identity;
    expect((await service.listPath('p', 'w'))[0]!.items[0]!.stale).toBe(false);
    variant.canvasRatio = '1:1';
    expect((await service.listPath('p', 'w'))[0]!.items[0]!.stale).toBe(true);
  });
});

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
        expect.objectContaining({
          where: { id: 'old-asset-0' },
          data: expect.objectContaining({ currentVersion: 1 }),
        }),
      );
      expect(db.assetVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ assetId: 'old-asset-0', version: 1 }),
        }),
      );
      expect(working.enqueueCleanup).toHaveBeenCalledWith(
        'p',
        'stored/old.mp4',
        'FINAL_OUTPUT_REPLACED',
      );
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
      const item = (
        outputRun.items as {
          fileObjectId?: string | null;
          assetId?: string | null;
          status: string;
        }[]
      )[0]!;
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
        record: {
          id: 'final-video:t:v0',
          artifactKey: 'final-video:t:v0',
          nodeId: 'FINAL_OUTPUT',
          revision: 1,
          contentHash: 'output-hash',
        },
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
    const { service, db, working, mix, run, workspace, variant, artifacts } =
      await localUpdateHarness();
    const sourceItems = run.items as {
      id: string;
      variantId: string;
      snapshot: FinalOutputSnapshot;
      status: string;
      fileObjectId: string | null;
      assetId: string | null;
    }[];
    const second = structuredClone(sourceItems[0]!);
    second.id = 'item-1';
    second.variantId = 'v1';
    second.snapshot.timeline.variant.id = 'v1';
    second.fileObjectId = 'old-file-1';
    second.assetId = 'old-asset-1';
    sourceItems.push(second);
    const secondVariant = structuredClone(variant);
    secondVariant.id = 'v1';
    workspace.draft.templates[0]!.workspace.variants.push(secondVariant);
    // Packaging is already frozen in these picture-only fixtures; focus on changed engineering.
    db.effectPackagingItem.findMany.mockResolvedValue([]);
    const old = structuredClone(run);
    variant.offsets.s = 1;
    const frozenWorkspace = structuredClone(workspace);
    const child = {
      ...structuredClone(run),
      id: 'child-output',
      workflowRunId: 'child',
      status: 'PENDING_RENDER',
      items: sourceItems.map((item) => ({
        ...structuredClone(item),
        id: `child-${item.id}`,
        status: 'PENDING_RENDER',
        fileObjectId: null,
        assetId: null,
      })),
    };
    const batches = [run, child];
    const allItems = () => batches.flatMap((batch) => batch.items) as typeof sourceItems;
    db.effectFinalOutputRun.findFirst.mockImplementation((args) =>
      Promise.resolve(
        args.where?.workflowRunId === 'child' ? child : args.where?.id === child.id ? child : run,
      ),
    );
    db.effectFinalOutputRun.update.mockImplementation(({ where, data }) =>
      Object.assign(
        batches.find((batch) => batch.id === where.id)!,
        data,
      ),
    );
    db.effectFinalOutputItem.update.mockImplementation(({ where, data }) =>
      Object.assign(
        allItems().find((item) => item.id === where.id)!,
        data,
      ),
    );
    db.effectFinalOutputItem.findUniqueOrThrow.mockImplementation(({ where }) =>
      Promise.resolve(allItems().find((item) => item.id === where.id)),
    );
    mix.outputSourceWorkspace.mockImplementation(
      async (_p, id) => ({ ...(id === 'child' ? frozenWorkspace : workspace), artifacts }) as never,
    );
    mix.workspace.mockImplementation(
      async (_p, id) => (id === 'child' ? frozenWorkspace : workspace) as never,
    );
    working.beginEffectNodeEdit.mockResolvedValue({
      runId: 'child',
      parentWorkflowRunId: 'w',
      productIdMap: {},
      taskIdMap: {},
      created: true,
    });
    await service.start('p', run.id, { resolution: '1080p', frameRate: 50 });
    expect(run).toEqual(old);
    expect(child.items).toHaveLength(2);
    expect(child.items.every((item) => item.status === 'QUEUED')).toBe(true);
    expect(child.items[0]!.snapshot.timeline.clips[0]!.offset).toBe(1);
    expect(child.items[1]!.snapshot.timeline.clips[0]!.offset).toBe(0);
    expect(child.items.every((item) => item.snapshot.resolution === '1080p')).toBe(true);
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith(
      'p',
      'w',
      'FINAL_OUTPUT',
      'BATCH',
      expect.objectContaining({ keepParentActive: true }),
    );
    // Another save after the fork must affect only the explicit parent update, not frozen child input.
    variant.offsets.s = 2;
    await service.localUpdate('p', run.id, { itemIds: ['item-0'] });
    expect(sourceItems[0]!.snapshot.timeline.clips[0]!.offset).toBe(2);
    expect(sourceItems[0]!.snapshot.resolution).toBe('720p');
    expect(sourceItems[0]!.fileObjectId).toBe('old-file-0');
    expect(sourceItems[1]).toEqual(old.items[1]);
    expect(child.items[0]!.snapshot.timeline.clips[0]!.offset).toBe(1);
    expect(db.jobOutbox.upsert.mock.calls.map(([args]) => args.create.aggregateId)).toEqual([
      'child-output',
      'out',
    ]);
    expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
  });
  it.each(['missing', 'incomplete', 'unavailable'])(
    'rejects %s current engineering without enqueueing or changing source files',
    async (failure) => {
      const context = await localUpdateHarness();
      const { service, db, working, mix, run, workspace, variant } = context;
      const old = structuredClone(run);
      forkExportHarness(context);
      if (failure === 'missing') workspace.draft.templates[0]!.workspace.variants = [];
      if (failure === 'incomplete') variant.bindings = {};
      if (failure === 'unavailable') workspace.materials[0]!.available = false;
      mix.outputSourceWorkspace.mockResolvedValue(workspace as never);
      await expect(
        service.start('p', run.id, { resolution: '720p', frameRate: 30 }),
      ).rejects.toThrow();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
      expect(run).toEqual(old);
      expect(db.effectFinalOutputRun.updateMany).toHaveBeenCalledWith({
        where: { projectId: 'p', id: 'child-out', status: 'PENDING_RENDER' },
        data: { status: 'FAILED', completedAt: expect.any(Date) },
      });
      expect(working.publishEffectNodeEdit).not.toHaveBeenCalled();
    },
  );
});

/** An exported batch whose delivery manifest can actually be written. */
async function delivered(count = 2) {
  const context = await exportedRun(count);
  // Delivery fixtures intentionally omit the live material bindings; they test file and manifest
  // integrity, while draft-picture drift is covered by the queue synchronization tests.
  vi.spyOn(
    context.service as unknown as { draftDiffersFromSnapshot: (...args: unknown[]) => boolean },
    'draftDiffersFromSnapshot',
  ).mockReturnValue(false);
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
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'other',
      branches: [
        {
          workflowRunId: 'root',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          createdAt: '0',
          templates: [{ templateId: 't' }, { templateId: 'other' }],
        },
        {
          workflowRunId: 'w',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 't',
          createdAt: '1',
          templates: [{ templateId: 't' }, { templateId: 'other' }],
        },
        {
          workflowRunId: 'other',
          parentWorkflowRunId: 'w',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'other',
          createdAt: '2',
          templates: [{ templateId: 't' }, { templateId: 'other' }],
        },
      ],
    } as never);
    db.workflowRun.findFirst.mockResolvedValue({ id: 'other' });
    await service.start('p', 'out', { resolution: '720p', frameRate: 30 });
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH', {
      always: true,
      keepParentActive: true,
      templateId: 't',
      templateScopeActiveRunId: 'other',
    });
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('rejects a replaced batch without creating a branch', async () => {
    const { service, db, working } = harness();
    db.effectFinalOutputRun.findMany.mockResolvedValue([]);
    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 })).rejects.toThrow(
      '成片工程已变化',
    );
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('exports from the same current confirmation path used by the list, not an older global pointer', async () => {
    const { service, db, working } = harness();
    await service.upsertFromPackaging('p', 'w', 't');
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'old',
      branches: [
        {
          workflowRunId: 'w',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          createdAt: '2026-10-04T00:00:00Z',
          templates: [{ templateId: 't', currentConfirmedAt: '2026-10-07T00:00:00Z' }],
        },
        {
          workflowRunId: 'old',
          parentWorkflowRunId: 'w',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 't',
          createdAt: '2026-10-06T00:00:00Z',
          templates: [{ templateId: 't', currentConfirmedAt: '2026-10-06T00:00:00Z' }],
        },
      ],
    } as never);
    db.workflowRun.findFirst.mockResolvedValue({ id: 'old' });
    await service.start('p', 'out', { resolution: '720p', frameRate: 30 });
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith('p', 'w', 'FINAL_OUTPUT', 'BATCH', {
      always: true,
      keepParentActive: true,
      templateId: 't',
      templateScopeActiveRunId: 'old',
    });
  });
  it('rejects activity that changes after template-tip resolution', async () => {
    const { service, db, working } = harness();
    db.workflowRun.findFirst.mockResolvedValue({ id: 'changed' });
    await expect(service.start('p', 'out', { resolution: '720p', frameRate: 30 })).rejects.toThrow(
      '工作流分支正在更新',
    );
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
  it('lists the latest confirmed template path even while the global pointer is an older packaging branch', async () => {
    const { service, db } = harness();
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'old',
      branches: [
        {
          workflowRunId: 'w',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          createdAt: '2026-10-04T00:00:00Z',
          templates: [{ templateId: 't', currentConfirmedAt: '2026-10-04T00:00:00Z' }],
        },
        {
          workflowRunId: 'old',
          parentWorkflowRunId: 'w',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 't',
          createdAt: '2026-10-05T00:00:00Z',
          templates: [{ templateId: 't', currentConfirmedAt: '2026-10-05T00:00:00Z' }],
        },
        {
          workflowRunId: 'latest',
          parentWorkflowRunId: 'w',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 't',
          createdAt: '2026-10-06T00:00:00Z',
          templates: [{ templateId: 't', currentConfirmedAt: '2026-10-07T00:00:00Z' }],
        },
      ],
    } as never);
    db.workflowRun.findMany.mockResolvedValue([]);
    const path = vi
      .spyOn(service, 'listPath')
      .mockResolvedValue([{ id: 'current-output', templateId: 't' }] as never);
    expect((await service.list('p', 'old')).map((batch) => batch.id)).toEqual(['current-output']);
    expect(path).toHaveBeenCalledExactlyOnceWith('p', 'latest', new Set(['t']));
  });
  it('shares one scoped catalog read across template paths without leaking sibling batches', async () => {
    const { service, db, outputRun } = harness();
    const tree = [
      {
        workflowRunId: 'w',
        parentWorkflowRunId: null,
        forkNodeId: null,
        forkTemplateId: null,
        createdAt: '2026-10-04T00:00:00Z',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
      {
        workflowRunId: 'child',
        parentWorkflowRunId: 'w',
        forkNodeId: 'FINAL_OUTPUT',
        forkTemplateId: 'other',
        createdAt: '2026-10-04T00:01:00Z',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
    ];
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'child',
      branches: tree,
    } as never);
    db.workflowRun.findMany.mockResolvedValue(
      tree.map((branch) => ({ ...branch, id: branch.workflowRunId })) as never,
    );
    const other = { ...outputRun, id: 'other-output', templateId: 'other', workflowRunId: 'child' };
    db.effectFinalOutputRun.findMany.mockResolvedValue([
      { ...outputRun, id: 'sibling-output', workflowRunId: 'sibling' },
      other,
      outputRun,
    ] as never);
    const result = await service.list('p', 'child');
    expect(result.map((batch) => batch.id)).toEqual(['out', 'other-output']);
    expect(db.workflowRun.findMany).toHaveBeenCalledTimes(2);
    expect(db.effectFinalOutputRun.findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { projectId: 'p', workflowRunId: { in: ['child', 'w'] } },
      }),
    );
    expect(db.workingArtifact.findMany).not.toHaveBeenCalled();
  });
  it('keeps an unpublished output child visible while it renders', async () => {
    const { service, db } = harness();
    db.workflowRun.findFirst.mockResolvedValue({
      id: 'child',
      parentWorkflowRunId: 'w',
      forkNodeId: 'FINAL_OUTPUT',
      forkTemplateId: 't',
    } as never);
    vi.spyOn(service, 'listPath').mockResolvedValue([{ id: 'running', templateId: 't' }] as never);
    expect((await service.list('p', 'child')).map((batch) => batch.id)).toEqual(['running']);
    expect(service.listPath).toHaveBeenCalledWith('p', 'child', new Set(['t']));
  });
  it('lists the nearest confirmed output batch for each template on the current branch path', async () => {
    const { service, db, mix, working, run } = await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    for (const item of run.items as Array<{
      fileObjectId: string | null;
      assetId: string | null;
    }>) {
      item.fileObjectId = null;
      item.assetId = null;
    }
    const older = {
      ...run,
      id: 'older-output',
      workflowRunId: 'parent',
      templateId: 'other-template',
    };
    run.workflowRunId = 'child';
    db.workflowRun.findMany.mockResolvedValue([
      {
        id: 'child',
        parentWorkflowRunId: 'parent',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 't',
      },
      {
        id: 'parent',
        parentWorkflowRunId: null,
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 'other-template',
      },
    ]);
    db.effectFinalOutputRun.findMany.mockResolvedValue([run, older]);
    const listed = await service.listPath('p', 'child');
    expect(listed.map((batch) => [batch.templateId, batch.workflowRunId])).toEqual([
      ['t', 'child'],
      ['other-template', 'parent'],
    ]);
    expect(mix.workspace).not.toHaveBeenCalled();
    expect(mix.outputSourceWorkspace).toHaveBeenCalledTimes(1);
    expect(working.listArtifacts).not.toHaveBeenCalled();
  });

  it('does not revive an older batch of the template being forked', async () => {
    const { service, db, run } = await localUpdateHarness(false);
    run.workflowRunId = 'parent';
    db.workflowRun.findMany.mockResolvedValue([
      {
        id: 'child',
        parentWorkflowRunId: 'parent',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 't',
      },
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
      run,
      { ...run, id: 'other-output', workflowRunId: 'parent', templateId: 'other-template' },
    ]);
    const listed = await service.listPath('p', 'w', new Set(['t']));
    expect(listed.map((batch) => batch.templateId)).toEqual(['t']);
    expect(mix.outputSourceWorkspace).toHaveBeenCalledExactlyOnceWith('p', 'w');
  });

  it('infers the template scope of a legacy fork from its own output batch', async () => {
    const { service, db, run } = await localUpdateHarness(false);
    const older = {
      ...run,
      id: 'older-output',
      workflowRunId: 'parent',
      templateId: 'other-template',
    };
    run.workflowRunId = 'child';
    db.workflowRun.findMany.mockResolvedValue([
      {
        id: 'child',
        parentWorkflowRunId: 'parent',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: null,
      },
      { id: 'parent', parentWorkflowRunId: null, forkNodeId: 'TEMPLATE_MIX', forkTemplateId: null },
    ]);
    db.effectFinalOutputRun.findMany.mockResolvedValue([run, older]);
    expect((await service.listPath('p', 'child')).map((batch) => batch.templateId)).toEqual([
      't',
      'other-template',
    ]);
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
        data: expect.objectContaining({
          status: 'PENDING_RENDER',
          progress: 0,
          errorMessage: null,
        }),
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
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            packaging: expect.objectContaining({ music: expect.objectContaining({ volume: 0.2 }) }),
          }),
        }),
      }),
    );
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
    const result = await service.syncFromDraft('p', 'w', {
      templateId: 't',
      expectedDraftRevision: 2,
    });
    expect(result).toEqual({ refreshed: [], superseded: true });
    expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });

  it('skips expensive queue synchronization for a delivered template but still reads exact draft differences', async () => {
    const { service, db, mix, working, variant } = await localUpdateHarness();
    db.workflowNodeState.findUnique.mockResolvedValue({ revision: 2 });
    variant.offsets.s = 1;
    expect(
      await service.syncFromDraft('p', 'w', { templateId: 't', expectedDraftRevision: 2 }),
    ).toEqual({ refreshed: [] });
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
    const result = await service.syncFromDraft('p', 'w', {
      templateId: 't',
      expectedDraftRevision: 2,
    });
    expect(result).toEqual({ refreshed: [{ templateId: 't', itemCount: 1 }] });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-0' },
        data: expect.objectContaining({ status: 'PENDING_RENDER' }),
      }),
    );
  });
  it('synchronizes a non-global template engineer without a render, branch, or stale output', async () => {
    const { service, db, mix, working, run, items, workspace, variant } =
      await localUpdateHarness(false);
    run.status = 'PENDING_RENDER';
    items.forEach((item) => {
      item.status = 'PENDING_RENDER';
      item.fileObjectId = null;
      item.assetId = null;
    });
    variant.offsets.s = 1;
    // A valid template source need not own the project-wide ACTIVE pointer.
    db.workflowRun.findFirst.mockImplementation(async ({ where }) =>
      where.activeKey ? null : { id: 'w' },
    );
    db.workflowNodeState.findUnique.mockResolvedValue({ revision: 2 });
    db.effectFinalOutputItem.findFirst.mockResolvedValue({ id: 'item-0' });
    mix.workspace.mockResolvedValue({ ...workspace, draftRevision: 2 });
    expect(
      await service.syncFromDraft('p', 'w', { templateId: 't', expectedDraftRevision: 2 }),
    ).toEqual({ refreshed: [{ templateId: 't', itemCount: 1 }] });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledOnce();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    const listed = await service.listPath('p', 'w');
    expect(listed[0]!.counts.stale).toBe(0);
    expect(listed[0]!.items[0]!.stale).toBe(false);
  });
});

describe('local update', () => {
  it('returns a net no-op without queuing, modifying films or calling paid work', async () => {
    const h = await localUpdateHarness(false);
    h.db.workflowNodeState.findUnique.mockResolvedValue({ revision: 2 });
    const result = await h.service.updateSourceProjects('p', {
      workflowRunId: 'w',
      templateId: 't',
      expectedDraftRevision: 2,
      variantIds: [],
      appendNewMaterials: true,
    });
    expect(result).toEqual({ noChanges: true });
    expect(h.db.effectFinalOutputRun.create).not.toHaveBeenCalled();
    expect(h.db.effectFinalOutputItem.update).not.toHaveBeenCalled();
  });
  it('keeps a new-protocol operation on its frozen file after later render edits, without relaxing engineering/file fences', async () => {
    const h = await localUpdateHarness(false);
    h.run.status = 'PENDING_RENDER';
    h.items[0]!.fileObjectId = null;
    h.items[0]!.assetId = null;
    h.workspace.materials[0]!.artifactRevision = 2;
    h.artifacts[0]!.id = 'clip';
    h.artifacts[0]!.revision = 2;
    Object.assign(h.artifacts[0]!, {
      payload: {
        ...(h.artifacts[0] as unknown as { payload: object }).payload,
        fileObjectId: 'video',
        contentHash: 'clip-hash',
      },
    });
    h.workspace.materials[0]!.artifactId = 'clip';
    h.db.fileObject.count.mockImplementation(({ where }) => Promise.resolve(where.id.in.length));
    h.db.fileObject.findMany.mockResolvedValue([{ id: 'video', sha256: 'clip-hash' }] as never);
    h.db.effectPackagingItem.findMany.mockResolvedValue([]);
    Object.assign(h.db.effectPackagingItem, { findFirst: vi.fn().mockResolvedValue(null) });
    h.db.workflowNodeState.findUnique.mockResolvedValue({ state: h.workspace.draft });
    h.db.workingArtifact.findFirst.mockResolvedValue(h.artifacts[0]!);
    (h.items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot.unpackaged = true;
    await h.service.localUpdate('p', 'out', { itemIds: ['item-0'] });
    const snapshot = (h.items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot;
    expect(snapshot.sourceRefresh?.protocol).toBe('FROZEN_RENDER_V1');
    const internals = h.service as unknown as {
      assertRefreshCurrent(
        tx: unknown,
        project: string,
        snapshot: FinalOutputSnapshot,
      ): Promise<void>;
    };
    h.artifacts[0]!.revision = 3;
    Object.assign(h.artifacts[0]!, {
      payload: { fileObjectId: 'new-video', contentHash: 'new-hash' },
    });
    await expect(internals.assertRefreshCurrent(h.db, 'p', snapshot)).resolves.toBeUndefined();
    const legacy = structuredClone(snapshot);
    delete legacy.sourceRefresh!.protocol;
    await expect(internals.assertRefreshCurrent(h.db, 'p', legacy)).rejects.toThrow(
      '素材再次发生变化',
    );
    h.db.fileObject.findMany.mockResolvedValue([]);
    await expect(internals.assertRefreshCurrent(h.db, 'p', snapshot)).rejects.toThrow(
      '冻结的素材文件',
    );
    h.db.fileObject.findMany.mockResolvedValue([{ id: 'video', sha256: 'clip-hash' }] as never);
    h.variant.offsets.s = 1;
    await expect(internals.assertRefreshCurrent(h.db, 'p', snapshot)).rejects.toThrow(
      '工程已被编辑',
    );
  });
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
  it('updates the selected template tip without requiring it to own the global active pointer', async () => {
    const { service, db, run, variant } = await localUpdateHarness();
    const branches = [
      {
        workflowRunId: 'root',
        parentWorkflowRunId: null,
        forkNodeId: null,
        forkTemplateId: null,
        createdAt: '0',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
      {
        workflowRunId: 'w',
        parentWorkflowRunId: 'root',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 't',
        createdAt: '1',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
      {
        workflowRunId: 'other-template-run',
        parentWorkflowRunId: 'w',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 'other',
        createdAt: '2',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
    ];
    db.workflowRun.findFirst.mockResolvedValue({ id: 'other-template-run' } as never);
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'other-template-run',
      branches,
    } as never);
    variant.offsets.s = 1;

    await expect(service.localUpdate('p', run.id, { itemIds: ['item-0'] })).resolves.toBeDefined();
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-0' },
        data: expect.objectContaining({ status: 'QUEUED' }),
      }),
    );
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('updates a selected template tip even when the global active Run is hidden or unavailable', async () => {
    const { service, db, run, variant } = await localUpdateHarness();
    const branches = [
      {
        workflowRunId: 'root',
        parentWorkflowRunId: null,
        forkNodeId: null,
        forkTemplateId: null,
        createdAt: '0',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
      {
        workflowRunId: 'w',
        parentWorkflowRunId: 'root',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 't',
        createdAt: '1',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
      {
        workflowRunId: 'other-template-run',
        parentWorkflowRunId: 'w',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 'other',
        createdAt: '2',
        templates: [{ templateId: 't' }, { templateId: 'other' }],
      },
    ];
    db.workflowRun.findFirst.mockResolvedValue(null as never);
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'root',
      branches,
    } as never);
    variant.offsets.s = 1;

    await expect(service.localUpdate('p', run.id, { itemIds: ['item-0'] })).resolves.toBeDefined();
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-0' },
        data: expect.objectContaining({ status: 'QUEUED' }),
      }),
    );
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('refuses a running batch and unchanged unexported projects', async () => {
    const queued = await localUpdateHarness();
    queued.run.status = 'RUNNING';
    await expect(queued.service.localUpdate('p', 'out', { itemIds: ['item-0'] })).rejects.toThrow(
      '正在渲染',
    );
    const pending = await localUpdateHarness();
    pending.run.status = 'PENDING_RENDER';
    pending.items[0]!.fileObjectId = null;
    pending.items[0]!.assetId = null;
    await expect(pending.service.localUpdate('p', 'out', { itemIds: ['item-0'] })).rejects.toThrow(
      '没有需要更新的素材',
    );
  });
  it.each([false, true])(
    'sync preserves source refresh baseline and queues an unexported project, replacement id=%s',
    async (replacementId) => {
      const { service, db, working, run, items, workspace, artifacts } =
        await localUpdateHarness(false);
      run.status = 'PENDING_RENDER';
      items[0]!.status = 'PENDING_RENDER';
      items[0]!.fileObjectId = null;
      items[0]!.assetId = null;
      workspace.materials[0]!.artifactRevision = 2;
      artifacts[0]!.id = 'clip';
      artifacts[0]!.revision = 2;
      const sourceArtifact = artifacts[0] as unknown as { payload: Record<string, unknown> };
      sourceArtifact.payload = {
        ...sourceArtifact.payload,
        fileObjectId: 'video',
        contentHash: 'clip-hash',
      };
      workspace.materials[0]!.artifactId = 'clip';
      if (replacementId) {
        const old = workspace.materials[0]!;
        Object.assign(old, { activeSource: false, sourcePromptId: 'pr', artifactRevision: 1 });
        const replacement = {
          ...old,
          id: 'replacement',
          artifactId: 'replacement',
          artifactRevision: 2,
        };
        Object.assign(replacement, { activeSource: true });
        workspace.materials.push(replacement);
        artifacts[0]!.id = 'replacement';
      }
      db.fileObject.count.mockImplementation(({ where }) => Promise.resolve(where.id.in.length));
      db.fileObject.findMany.mockResolvedValue([{ id: 'video', sha256: 'clip-hash' }] as never);
      db.effectPackagingItem.findMany.mockResolvedValue([]);
      (items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot.unpackaged = true;
      Object.assign(db.effectPackagingItem, { findFirst: vi.fn().mockResolvedValue(null) });
      db.workflowNodeState.findUnique.mockResolvedValue({ state: workspace.draft });
      db.workingArtifact.findFirst.mockResolvedValue(artifacts[0]);
      const baseline = JSON.stringify(
        (items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot,
      );
      expect(await service.syncFromDraft('p', 'w')).toEqual({ refreshed: [] });
      expect(db.effectFinalOutputItem.update).not.toHaveBeenCalled();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
      expect(
        JSON.stringify((items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot),
      ).toBe(baseline);
      await service.localUpdate('p', 'out', { itemIds: ['item-0'] });
      const snapshot = (items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot;
      expect(snapshot.projectRefreshOnly).toBe(true);
      expect(snapshot.sourceRefresh?.slots.map((row) => row.slotId)).toEqual(['s']);
      expect(snapshot.timeline.variant.bindings.s).toBe(replacementId ? 'replacement' : 'clip');
      expect(snapshot.timeline.variant.bindingRevisions.s).toBe(2);
      expect(run.status).toBe('QUEUED');
      expect(items[0]!.fileObjectId).toBeNull();
      expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
      expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
      expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
    },
  );
  it.each(['QUEUED', 'RUNNING', 'FAILED'])(
    'does not claim an unrelated legacy %s picture during a source refresh',
    async (legacyStatus) => {
      const { service, db, run, items, workspace, artifacts } = await localUpdateHarness(false);
      run.status = 'PENDING_RENDER';
      items[0]!.status = 'PENDING_RENDER';
      items[0]!.fileObjectId = null;
      items[0]!.assetId = null;
      const unrelated = {
        ...structuredClone(items[0]!),
        id: 'legacy',
        variantId: 'other',
        status: legacyStatus,
      };
      Object.assign((unrelated as unknown as { snapshot: FinalOutputSnapshot }).snapshot, {
        sourceOperation: { id: 'previous-source-operation' },
      });
      items.push(unrelated);
      workspace.draft.templates[0]!.workspace.variants.push({
        ...structuredClone(workspace.draft.templates[0]!.workspace.variants[0]!),
        id: 'other',
      });
      const before = JSON.stringify(unrelated);
      workspace.materials[0]!.artifactRevision = 2;
      artifacts[0]!.id = 'clip';
      artifacts[0]!.revision = 2;
      Object.assign((artifacts[0] as unknown as { payload: object }).payload, {
        fileObjectId: 'video',
        contentHash: 'clip-hash',
      });
      workspace.materials[0]!.artifactId = 'clip';
      db.fileObject.count.mockImplementation(({ where }) => Promise.resolve(where.id.in.length));
      db.fileObject.findMany.mockResolvedValue([{ id: 'video', sha256: 'clip-hash' }] as never);
      db.effectPackagingItem.findMany.mockResolvedValue([]);
      (items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot.unpackaged = true;
      db.workflowNodeState.findUnique.mockResolvedValue({ state: workspace.draft });
      db.workingArtifact.findFirst.mockResolvedValue(artifacts[0]);
      await service.localUpdate('p', 'out', { itemIds: ['item-0'] });
      expect(unrelated.status).toBe('PENDING_RENDER');
      expect(
        JSON.stringify({
          ...unrelated,
          status: legacyStatus,
          progress: undefined,
          errorMessage: undefined,
        }),
      ).toBe(
        JSON.stringify({ ...JSON.parse(before), progress: undefined, errorMessage: undefined }),
      );
      Object.assign(run, { updatedAt: new Date() });
      const claim = await service.claim('p', 'out');
      expect(
        claim.items?.filter((item) => item.status === 'QUEUED').map((item) => item.id),
      ).toEqual(['item-0']);
    },
  );
  it('refuses unchanged films and a historical template path without creating a paid task', async () => {
    const unchanged = await localUpdateHarness();
    await expect(
      unchanged.service.localUpdate('p', 'out', { itemIds: ['item-0'] }),
    ).rejects.toThrow('无需局部更新');
    expect(unchanged.db.jobOutbox.upsert).not.toHaveBeenCalled();
    const oldBranch = await localUpdateHarness();
    oldBranch.variant.offsets.s = 1;
    const branches = [
      {
        workflowRunId: 'root',
        parentWorkflowRunId: null,
        forkNodeId: null,
        forkTemplateId: null,
        createdAt: '0',
        templates: [{ templateId: 't' }],
      },
      {
        workflowRunId: 'w',
        parentWorkflowRunId: 'root',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 't',
        createdAt: '1',
        templates: [{ templateId: 't' }],
      },
      {
        workflowRunId: 'new-template-tip',
        parentWorkflowRunId: 'w',
        forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 't',
        createdAt: '2',
        templates: [{ templateId: 't' }],
      },
    ];
    vi.mocked(oldBranch.service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'new-template-tip',
      branches,
    } as never);
    await expect(
      oldBranch.service.localUpdate('p', 'out', { itemIds: ['item-0'] }),
    ).rejects.toThrow('该模板的当前成片分支');
    expect(oldBranch.db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('marks a changed soundtrack and re-renders it in the same output branch', async () => {
    const { service, db, rows, working } = await localUpdateHarness();
    rows[0]!.checkpoint.music.volume = 0.2;
    const listed = await service.listPath('p', 'w');
    expect(listed[0]?.items[0]?.stale).toBe(true);
    await service.localUpdate('p', 'out', { itemIds: ['item-0'] });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            packaging: expect.objectContaining({ music: expect.objectContaining({ volume: 0.2 }) }),
          }),
        }),
      }),
    );
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('refreshes the consumed artifact revisions when a film is locally updated', async () => {
    const { service, artifacts, items } = await localUpdateHarness();
    const snapshot = (items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot;
    const source = artifacts.find(
      (artifact) => artifact.id === snapshot.dependencies[0]?.artifactId,
    )!;
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
  it('removes the last deleted project and commits an empty delivery without rendering or forking', async () => {
    const gone = await localUpdateHarness();
    gone.workspace.draft!.templates[0]!.workspace.variants = [];
    gone.db.effectFinalOutputItem.deleteMany.mockImplementation(async () => {
      gone.items.splice(0);
      return { count: 1 };
    });
    const before = await gone.service.get('p', 'out');
    expect(before.projectChanges?.removedItemIds).toEqual(['item-0']);
    expect(before.counts.stale).toBe(1);
    const result = await gone.service.localUpdate('p', 'out', { itemIds: ['item-0'] });
    expect(result.items).toEqual([]);
    expect(result.counts.stale).toBe(0);
    expect(gone.db.effectFinalOutputItem.deleteMany).toHaveBeenCalledWith({
      where: {
        projectId: 'p',
        runId: 'out',
        id: { in: ['item-0'] },
      },
    });
    expect(gone.working.commitValidatedArtifactsInTransaction).toHaveBeenCalledWith(
      gone.db,
      'p',
      'w',
      'FINAL_OUTPUT',
      [
        expect.objectContaining({
          artifactKey: 'final-delivery:t',
          input: expect.objectContaining({
            payload: expect.objectContaining({ items: [] }),
            files: [],
          }),
        }),
      ],
    );
    expect(gone.db.jobOutbox.upsert).not.toHaveBeenCalled();
    expect(gone.working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(gone.db.fileObject.delete).not.toHaveBeenCalled();
    await expect(
      gone.service.localUpdate('p', 'out', { itemIds: [], syncProjects: true }),
    ).rejects.toThrow('无需局部更新');
  });
  it('still rejects unusable sources without queueing a task', async () => {
    // A missing source file is a real rendering error, not a semantic package-expiry decision.
    const broken = await localUpdateHarness();
    broken.workspace.materials = [];
    await expect(broken.service.localUpdate('p', 'out', { itemIds: ['item-0'] })).rejects.toThrow(
      '原素材来源无法确认',
    );
    expect(broken.db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it.each(['draft-only', 'other-template', 'unavailable', 'wrong-node'] as const)(
    'does not expose or execute 13 unconfirmed drafts as additions (%s)',
    async (kind) => {
      const { service, workspace, artifacts, db, working, items } = await membershipUpdateHarness();
      const at = artifacts.findIndex((artifact) => artifact.id === 'new-timeline');
      const unconfirmed = artifacts.splice(at, 1)[0]!;
      if (kind !== 'draft-only')
        artifacts.push({
          ...unconfirmed,
          ...(kind === 'other-template'
            ? { artifactKey: 'timeline-project:other:new-project' }
            : {}),
          ...(kind === 'unavailable' ? { availability: 'MISSING' } : {}),
          ...(kind === 'wrong-node' ? { nodeId: 'FINAL_OUTPUT' } : {}),
        } as never);
      const drafts = workspace.draft.templates[0]!.workspace.variants;
      for (let index = 1; index < 13; index++)
        drafts.push({ ...structuredClone(drafts[1]!), id: `unsubmitted-${index}` });
      const before = structuredClone(items);
      for (let read = 0; read < 2; read++) {
        const detail = await service.get('p', 'out');
        expect(detail.projectChanges).toMatchObject({ added: [], removedItemIds: [] });
        expect(detail.counts.stale).toBe(0);
        expect(detail.items.every((item) => !item.stale)).toBe(true);
        expect((await service.listPath('p', 'w'))[0]?.counts.stale).toBe(0);
      }
      await expect(
        service.localUpdate('p', 'out', { itemIds: [], syncProjects: true }),
      ).rejects.toThrow('无需局部更新');
      expect(items).toEqual(before);
      expect(drafts).toHaveLength(14);
      expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
      expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
      expect(working.commitValidatedArtifactsInTransaction).not.toHaveBeenCalled();
    },
  );

  it('detects added projects and renders only additions in the same branch using existing output settings', async () => {
    const context = await membershipUpdateHarness();
    const { service, db, working, items } = context;
    const old = structuredClone(items[0]);
    const before = await service.listPath('p', 'w');
    expect(before[0]?.projectChanges?.added).toEqual([
      expect.objectContaining({
        variantId: 'new-project',
        name: '新成片',
        duration: 10,
      }),
    ]);
    expect(before[0]?.counts.stale).toBe(1);
    expect(before[0]?.items[0]?.stale).toBe(false);
    await service.localUpdate('p', 'out', { itemIds: [], syncProjects: true });
    expect(items[0]).toEqual(old);
    expect(items[1]).toMatchObject({
      variantId: 'new-project',
      status: 'QUEUED',
      snapshot: { resolution: '1080p', frameRate: 25, unpackaged: true },
    });
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifactsInTransaction).toHaveBeenCalledWith(
      db,
      'p',
      'w',
      'TEMPLATE_MIX',
      [{ artifactKey: 'timeline-project:t:new-project', input: {} }],
    );
    await expect(
      service.localUpdate('p', 'out', { itemIds: [], syncProjects: true }),
    ).rejects.toThrow('正在渲染');
    expect(db.effectFinalOutputItem.create).toHaveBeenCalledOnce();
  });
  it('updates delivered films and reuses appended pending rows together without creating a branch', async () => {
    const { service, db, working, run, items, variant } = await membershipUpdateHarness();
    const original = items[0] as unknown as { snapshot: FinalOutputSnapshot };
    const pending = {
      ...structuredClone(items[0]!),
      id: 'appended-item',
      variantId: 'new-project',
      status: 'PENDING_RENDER',
      fileObjectId: null,
      assetId: null,
    };
    const pendingSnapshot = (pending as unknown as { snapshot: FinalOutputSnapshot }).snapshot;
    pendingSnapshot.resolution = '720p';
    pendingSnapshot.frameRate = 30;
    items.unshift(pending);
    db.effectFinalOutputItem.update.mockImplementation(async ({ where, data }) => {
      const item = items.find((item) => item.id === where.id)!;
      return Object.assign(item, data);
    });
    run.status = 'PENDING_RENDER';
    variant.offsets.s = 1;
    const before = await service.get('p', 'out');
    expect(before.counts.stale).toBe(2);
    expect(before.projectChanges?.added.map((item) => item.variantId)).toEqual(['new-project']);
    expect(before.resolution).toBe('1080p');
    expect(before.frameRate).toBe(25);
    expect((await service.listPath('p', 'w'))[0]?.counts.stale).toBe(2);

    await service.localUpdate('p', 'out', { itemIds: ['item-0'], syncProjects: true });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.status === 'QUEUED')).toBe(true);
    expect(pending).toMatchObject({
      id: 'appended-item',
      snapshot: { resolution: '1080p', frameRate: 25 },
    });
    expect(original.snapshot.projectRefreshOnly).not.toBe(true);
    expect(items.find((item) => item.id === 'item-0')?.fileObjectId).toBe('old-file-0');
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('synchronizes additions and deletions together, without queueing the deleted project', async () => {
    const { service, db, workspace, items } = await membershipUpdateHarness();
    workspace.draft.templates[0]!.workspace.variants.splice(0, 1);
    db.effectFinalOutputItem.deleteMany.mockImplementation(async () => {
      const index = items.findIndex((item) => item.id === 'item-0');
      items.splice(index, 1);
      return { count: 1 };
    });
    const before = await service.get('p', 'out');
    expect(before.counts.stale).toBe(2);
    await service.localUpdate('p', 'out', { itemIds: ['item-0'], syncProjects: true });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ variantId: 'new-project', status: 'QUEUED' });
    expect(db.effectFinalOutputItem.update).toHaveBeenCalledOnce();
    expect(db.jobOutbox.upsert).toHaveBeenCalledOnce();
  });
  it('does not expose a new empty project or its template markers as pending output', async () => {
    const { service, workspace, db } = await membershipUpdateHarness();
    const added = workspace.draft.templates[0]!.workspace.variants[1]!;
    added.bindings = {};
    const before = await service.get('p', 'out');
    expect(before.projectChanges?.added).toEqual([]);
    expect(before.counts.stale).toBe(0);
    await expect(
      service.localUpdate('p', 'out', { itemIds: [], syncProjects: true }),
    ).rejects.toThrow('无需局部更新');
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it.each(['captions', 'voice', 'detachedAudio'] as const)(
    'renders an added %s-only project without filling template slots',
    async (kind) => {
      const { service, workspace, items } = await membershipUpdateHarness();
      const added = workspace.draft.templates[0]!.workspace.variants[1]!;
      added.bindings = {};
      if (kind === 'captions') added.captions = [{ id: 'c', text: '标题', start: 0, end: 3 }];
      if (kind === 'voice')
        added.voice = {
          fileObjectId: 'voice',
          name: '口播',
          start: 0,
          duration: 3,
          offset: 0,
          volume: 1,
        };
      if (kind === 'detachedAudio')
        added.detachedAudios = [
          {
            id: 'audio',
            fileObjectId: 'voice',
            name: '音频',
            sourceType: 'FILE',
            audioKind: 'VOICE',
            start: 0,
            duration: 3,
            sourceDuration: 3,
            offset: 0,
            volume: 1,
          },
        ];
      expect((await service.get('p', 'out')).projectChanges?.added).toEqual([
        expect.objectContaining({ variantId: added.id, duration: 3, cover: null }),
      ]);
      await service.localUpdate('p', 'out', { itemIds: [], syncProjects: true });
      expect(items[1]).toMatchObject({ snapshot: { timeline: { clips: [], duration: 3 } } });
    },
  );
  it('rejects an outdated draft confirmation before deletion or queueing', async () => {
    const { service, workspace, db } = await membershipUpdateHarness();
    Object.assign(workspace, { draftRevision: 8 });
    await expect(
      service.localUpdate('p', 'out', {
        itemIds: [],
        syncProjects: true,
        expectedDraftRevision: 7,
      }),
    ).rejects.toThrow('成片工程已变化');
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.deleteMany).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('ignores decorative marker edits but fences real edits or deletion during rendering', async () => {
    const { service, workspace, db, items } = await membershipUpdateHarness();
    await service.localUpdate('p', 'out', { itemIds: [], syncProjects: true });
    const snapshot = (items[1] as unknown as { snapshot: FinalOutputSnapshot }).snapshot;
    const guard = service as unknown as {
      assertOutputDraft: (
        db: unknown,
        project: string,
        snapshot: FinalOutputSnapshot,
      ) => Promise<void>;
    };
    db.workflowNodeState.findUnique.mockResolvedValue({ state: workspace.draft });
    const added = workspace.draft.templates[0]!.workspace.variants[1]!;
    added.slots.push({ ...added.slots[0]!, id: 'marker', duration: 4 });
    await expect(guard.assertOutputDraft(db, 'p', snapshot)).resolves.toBeUndefined();
    added.captions = [{ id: 'changed', text: '新标题', start: 0, end: 3 }];
    await expect(guard.assertOutputDraft(db, 'p', snapshot)).rejects.toThrow('已编辑或删除');
    workspace.draft.templates[0]!.workspace.variants.splice(1);
    await expect(guard.assertOutputDraft(db, 'p', snapshot)).rejects.toThrow('已编辑或删除');
  });
  it('rejects incomplete additions before removing existing output or scheduling paid work', async () => {
    const { service, db, mix, workspace, variant } = await membershipUpdateHarness();
    workspace.draft.templates[0]!.workspace.variants.splice(0, 1);
    mix.prepareValidation.mockResolvedValue({ variants: [variant], inputs: [] });
    await expect(
      service.localUpdate('p', 'out', { itemIds: ['item-0'], syncProjects: true }),
    ).rejects.toThrow('新增成片工程仍有素材缺口');
    expect(db.effectFinalOutputItem.deleteMany).not.toHaveBeenCalled();
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('requires explicit project synchronization for additions, and guards historical branches', async () => {
    const { service, db, working } = await membershipUpdateHarness();
    await expect(service.localUpdate('p', 'out', { itemIds: [] })).rejects.toThrow('请先选择');
    working.beginEffectNodeEdit.mockClear();
    vi.mocked(service.branches.getEffectBranchTree).mockResolvedValue({
      projectId: 'p',
      activeWorkflowRunId: 'new-template-tip',
      branches: [
        {
          workflowRunId: 'root',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          createdAt: '0',
          templates: [{ templateId: 't' }],
        },
        {
          workflowRunId: 'w',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 't',
          createdAt: '1',
          templates: [{ templateId: 't' }],
        },
        {
          workflowRunId: 'new-template-tip',
          parentWorkflowRunId: 'w',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 't',
          createdAt: '2',
          templates: [{ templateId: 't' }],
        },
      ],
    } as never);
    await expect(
      service.localUpdate('p', 'out', { itemIds: [], syncProjects: true }),
    ).rejects.toThrow('该模板的当前成片分支');
    expect(db.effectFinalOutputItem.create).not.toHaveBeenCalled();
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
  });
  it('retains output settings after all projects were removed and a new one is added', async () => {
    const { service, items, workspace, artifacts } = await membershipUpdateHarness();
    items.splice(0);
    workspace.draft.templates[0]!.workspace.variants.splice(0, 1);
    const delivery = artifacts.find((artifact) => artifact.id === 'delivery')!;
    (delivery as unknown as { payload: unknown }).payload = {
      runId: 'out',
      resolution: '1080p',
      frameRate: 25,
      items: [],
    };
    const before = await service.get('p', 'out');
    expect(before).toMatchObject({ resolution: '1080p', frameRate: 25, validated: true });
    await service.localUpdate('p', 'out', { itemIds: [], syncProjects: true });
    expect(items[0]).toMatchObject({ snapshot: { resolution: '1080p', frameRate: 25 } });
  });
  it('preserves manual audio, captions and imported music in a newly added project', async () => {
    const { service, items, workspace } = await membershipUpdateHarness();
    const added = workspace.draft.templates[0]!.workspace.variants[1]!;
    added.voice = {
      fileObjectId: 'voice',
      name: '人工口播',
      start: 0,
      duration: 2,
      offset: 0,
      volume: 0.5,
    };
    added.bgm = {
      fileObjectId: 'music',
      name: '人工音乐',
      start: 0,
      duration: 10,
      offset: 0,
      volume: 0.2,
    };
    added.captions = [{ id: 'caption', text: '人工字幕', start: 0, end: 2 }];
    added.detachedAudios = [
      {
        id: 'imported',
        fileObjectId: 'music',
        name: '导入音乐',
        sourceAssetId: 'project-music',
        sourceType: 'FILE',
        audioKind: 'MUSIC',
        duration: 10,
        sourceDuration: 10,
        start: 0,
        offset: 0,
        volume: 0.2,
      },
    ];
    await service.localUpdate('p', 'out', { itemIds: [], syncProjects: true });
    expect(items[1]).toMatchObject({
      snapshot: {
        unpackaged: false,
        timeline: { detachedAudios: added.detachedAudios },
        packaging: { voices: { manual: added.voice }, music: added.bgm, captions: added.captions },
      },
    });
  });
});

async function membershipUpdateHarness() {
  const context = await localUpdateHarness();
  const added = { ...structuredClone(context.variant), id: 'new-project', name: '新成片' };
  context.workspace.draft.templates[0]!.workspace.variants.push(added);
  context.mix.prepareValidation.mockResolvedValue({
    variants: [context.variant, added],
    inputs: [{ artifactKey: 'timeline-project:t:new-project', input: {} }],
  });
  context.artifacts.push({
    id: 'new-timeline',
    artifactKey: 'timeline-project:t:new-project',
    nodeId: 'TEMPLATE_MIX',
    revision: 1,
    contentHash: 'new-timeline-hash',
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
    dependencies: [],
  } as never);
  context.db.effectFinalOutputItem.create.mockImplementation(async ({ data }) => {
    const item = {
      id: 'new-item',
      ...data,
      fileObjectId: null,
      assetId: null,
      progress: 0,
      errorMessage: null,
    };
    context.items.push(item);
    return item;
  });
  context.db.fileObject.count.mockImplementation(async ({ where }) => where.id.in.length);
  const baseline = context.items[0] as unknown as { snapshot: FinalOutputSnapshot };
  baseline.snapshot.resolution = '1080p';
  baseline.snapshot.frameRate = 25;
  return context;
}

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
    Promise.resolve(items.find((item) => item.id === where.id)),
  );
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
    ...((items[0] as unknown as { snapshot: FinalOutputSnapshot }).snapshot.dependencies ?? []).map(
      (dependency) => ({
        id: dependency.artifactId,
        artifactKey: dependency.artifactId,
        nodeId: 'TEMPLATE_MIX',
        revision: dependency.revision,
        contentHash: dependency.contentHash,
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
        dependencies: [],
      }),
    ),
    ...(withOutputVersion
      ? [
          {
            id: 'delivery',
            artifactKey: 'final-delivery:t',
            nodeId: 'FINAL_OUTPUT',
            revision: 1,
            contentHash: 'delivery-hash',
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
            dependencies: [],
          },
        ]
      : []),
  ];
  context.db.workingArtifact.findMany.mockResolvedValue(artifacts);
  context.mix.outputSourceWorkspace.mockResolvedValue({ ...workspace, artifacts } as never);
  // The workbench exit reads through the repository, the local update through the transaction client.
  context.working.listArtifacts.mockResolvedValue(artifacts);
  // The minimal packaging fixture above freezes only a file id. Make this exported baseline match
  // the real clip structure so an untouched draft is not spuriously reported as changed.
  const baseline = items[0] as unknown as { snapshot: FinalOutputSnapshot };
  baseline.snapshot.timeline.clips = (
    context.service as unknown as {
      liveClips: (
        variant: EffectTemplateMixVariant,
        materials: unknown[],
        artifacts: unknown[],
      ) => PackagingSnapshot['clips'];
    }
  ).liveClips(variant, workspace.materials, artifacts);
  const run = context.outputRun;
  context.db.effectFinalOutputRun.findMany.mockResolvedValue([run]);
  // The queueing above is the fixture, not the behaviour under test, so the call log starts empty.
  vi.clearAllMocks();
  return { ...context, items, run, workspace, variant, artifacts };
}
