import type { EffectImportProduct } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_VIDEO_CONFIG } from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { effectSegmentRenderSummary } from '../effect-segment-render-state';
import {
  clearEffectSegmentRenderMockWorkspaces,
  createEffectSegmentRenderExport,
  deleteEffectSegmentRenderMaterials,
  importEffectSegmentRenderFiles,
  inspectEffectSegmentRenderImports,
  loadEffectSegmentRenderWorkspace,
  regenerateEffectSegmentRenderTasks,
  startEffectSegmentRenderBatch,
  subscribeEffectSegmentRenderWorkspace,
  waitForEffectSegmentRenderMockBatch,
} from './effect-segment-render.mock-service';

const product = (id: string, name = '广式腊肠'): EffectImportProduct => ({
  id,
  projectId: 'project-1',
  draftId: 'draft-1',
  status: 'ACTIVE',
  removedAt: null,
  purgeAfter: null,
  name,
  category: '食品',
  sku: `SKU-${id}`,
  normalizedSku: `SKU-${id}`,
  commerceUrl: null,
  configOverride: {},
  effectiveConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
  sortOrder: 0,
  sourceManifestImportId: null,
  sourceManifestRowNumber: null,
  materials: [],
  commitStatus: 'COMMITTED',
  sourcePackageRevision: 1,
  effectiveVideoConfigRevision: 1,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
});

const context = { projectId: 'project-1', workflowRunId: 'run-1' };

afterEach(() => {
  clearEffectSegmentRenderMockWorkspaces();
  vi.unstubAllGlobals();
});

describe('effect segment render mock service', () => {
  it('loads a prompt-ready workspace without creating video tasks or making a network request', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('fetch must not be called');
    });
    vi.stubGlobal('fetch', fetchMock);
    const workspace = await loadEffectSegmentRenderWorkspace(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(workspace).toMatchObject({ promptCount: 50, batchStatus: 'NOT_STARTED' });
    expect(workspace.tasks).toHaveLength(0);
    expect(effectSegmentRenderSummary(workspace.tasks)).toEqual({
      total: 0,
      completed: 0,
      running: 0,
      failed: 0,
    });
  });

  it('isolates workspaces by project, workflow run and product', async () => {
    await startEffectSegmentRenderBatch(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      { stepDelayMs: 0 },
    );
    const otherProduct = await loadEffectSegmentRenderWorkspace(
      context,
      product('product-2', '脆骨酱'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
    );
    const otherRun = await loadEffectSegmentRenderWorkspace(
      { ...context, workflowRunId: 'run-2' },
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
    );
    expect(otherProduct.tasks).toHaveLength(0);
    expect(otherRun.tasks).toHaveLength(0);
    expect(otherProduct).toMatchObject({ productId: 'product-2', batchStatus: 'NOT_STARTED' });
  });

  it('auto-retries recoverable tasks and marks the final abnormal task', async () => {
    const updates: string[][] = [];
    const workspace = await startEffectSegmentRenderBatch(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      {
        stepDelayMs: 0,
        onUpdate: (next) => updates.push(next.tasks.map((task) => task.status)),
      },
    );
    expect(updates[0]?.every((status) => status === 'QUEUED')).toBe(true);
    expect(updates.some((statuses) => statuses.includes('AUTO_RETRY'))).toBe(true);
    expect(workspace.batchStatus).toBe('PARTIAL');
    expect(new Set(workspace.tasks.map((task) => task.promptId)).size).toBe(50);
    expect(workspace.tasks.every((task) => task.promptText.includes('不生成完整成片时间线'))).toBe(
      true,
    );
    expect(workspace.tasks.some((task) => task.compatibleFragmentTypes.length > 0)).toBe(true);
    expect(
      workspace.tasks.every((task) => !task.compatibleFragmentTypes.includes(task.fragmentType)),
    ).toBe(true);
    expect(effectSegmentRenderSummary(workspace.tasks)).toEqual({
      total: 50,
      completed: 49,
      running: 0,
      failed: 1,
    });
    const failed = workspace.tasks.find((task) => task.status === 'FAILED');
    expect(failed).toMatchObject({ retryCount: 2, abnormal: true });

    const recovered = await regenerateEffectSegmentRenderTasks(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      [failed!.id],
      { stepDelayMs: 0 },
    );
    expect(effectSegmentRenderSummary(recovered.tasks).failed).toBe(0);
    expect(recovered.tasks.find((task) => task.id === failed!.id)).toMatchObject({
      status: 'COMPLETED',
      progress: 100,
      abnormal: false,
    });
    expect(recovered.batchStatus).toBe('COMPLETED');
  });

  it('returns queued tasks first and keeps the mock job running while the page is left', async () => {
    const statuses: string[] = [];
    const unsubscribe = subscribeEffectSegmentRenderWorkspace(context, 'product-1', (workspace) =>
      statuses.push(workspace.batchStatus),
    );
    const queued = await startEffectSegmentRenderBatch(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      { stepDelayMs: 5 },
    );
    expect(queued.batchStatus).toBe('QUEUED');
    expect(queued.tasks).toHaveLength(50);
    expect(queued.tasks.every((task) => task.status === 'QUEUED')).toBe(true);
    unsubscribe();

    await waitForEffectSegmentRenderMockBatch(context, 'product-1');
    const restored = await loadEffectSegmentRenderWorkspace(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
    );
    expect(statuses).toContain('QUEUED');
    expect(restored.batchStatus).toBe('PARTIAL');
    expect(effectSegmentRenderSummary(restored.tasks)).toEqual({
      total: 50,
      completed: 49,
      running: 0,
      failed: 1,
    });
  });

  it('matches imported videos to prompt slots and preserves them when the batch starts', async () => {
    const files = [
      { name: 'product-shot.mp4', size: 1024, type: 'video/mp4', lastModified: 1 },
      { name: 'brand-close-up.mov', size: 2048, type: 'video/quicktime', lastModified: 2 },
    ];
    const inspected = await inspectEffectSegmentRenderImports(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      files,
    );
    expect(inspected).toHaveLength(2);
    expect(inspected.every((item) => item.promptCode)).toBe(true);

    const imported = await importEffectSegmentRenderFiles(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      files,
    );
    expect(imported.batchStatus).toBe('NOT_STARTED');
    expect(imported.tasks).toHaveLength(2);
    expect(imported.tasks.every((task) => task.origin === 'EXTERNAL_IMPORT')).toBe(true);

    const finished = await startEffectSegmentRenderBatch(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      { stepDelayMs: 0 },
    );
    expect(finished.tasks).toHaveLength(50);
    expect(finished.tasks.filter((task) => task.origin === 'EXTERNAL_IMPORT')).toHaveLength(2);
    expect(finished.tasks.filter((task) => task.status === 'FAILED')).toHaveLength(1);
  });

  it('creates a local mock export manifest for completed materials only', async () => {
    const workspace = await startEffectSegmentRenderBatch(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      { stepDelayMs: 0 },
    );
    const completed = workspace.tasks.filter((task) => task.status === 'COMPLETED').slice(0, 3);
    const receipt = await createEffectSegmentRenderExport(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      completed.map((task) => task.id),
      ['VIDEO_PACKAGE', 'MANIFEST_JSON'],
    );
    expect(receipt.taskCount).toBe(3);
    expect(receipt.fileName).toContain('视频素材导出清单');
    expect(JSON.parse(receipt.content)).toMatchObject({
      mock: true,
      requestedFormats: ['VIDEO_PACKAGE', 'MANIFEST_JSON'],
    });
  });

  it('deletes only material results while preserving prompt slots for regeneration', async () => {
    const workspace = await startEffectSegmentRenderBatch(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      { stepDelayMs: 0 },
    );
    const selected = workspace.tasks.filter((task) => task.status === 'COMPLETED').slice(0, 2);
    const deleted = await deleteEffectSegmentRenderMaterials(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      selected.map((task) => task.id),
    );
    expect(deleted.tasks).toHaveLength(50);
    expect(deleted.batchStatus).toBe('PARTIAL');
    expect(
      deleted.tasks.filter((task) => task.errorMessage?.includes('素材结果已删除')),
    ).toHaveLength(2);
    expect(effectSegmentRenderSummary(deleted.tasks)).toEqual({
      total: 50,
      completed: 47,
      running: 0,
      failed: 3,
    });
  });
});
