import type { EffectImportProduct } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_VIDEO_CONFIG } from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { effectSegmentRenderSummary } from '../effect-segment-render-state';
import {
  clearEffectSegmentRenderMockWorkspaces,
  deleteEffectSegmentRenderTasks,
  exportEffectSegmentRenderTasks,
  importEffectSegmentRenderFiles,
  loadEffectSegmentRenderWorkspace,
  regenerateEffectSegmentRenderTasks,
  startEffectSegmentRenderBatch,
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
  it('loads fifty prompt-derived tasks without making a network request', async () => {
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
    expect(workspace.tasks).toHaveLength(50);
    expect(effectSegmentRenderSummary(workspace.tasks)).toEqual({
      total: 50,
      completed: 47,
      running: 3,
      failed: 0,
    });
    expect(new Set(workspace.tasks.map((task) => task.promptId)).size).toBe(50);
    expect(workspace.tasks.every((task) => task.promptId && task.promptCode)).toBe(true);
    expect(workspace.tasks.every((task) => task.promptText.includes('不生成完整成片时间线'))).toBe(
      true,
    );
  });

  it('isolates workspaces by project, workflow run and product', async () => {
    const first = await loadEffectSegmentRenderWorkspace(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
    );
    await deleteEffectSegmentRenderTasks(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      [first.tasks[0]!.id],
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
    expect(otherProduct.tasks).toHaveLength(50);
    expect(otherRun.tasks).toHaveLength(50);
    expect(otherProduct.tasks[0]?.productName).toBe('脆骨酱');
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
    expect(updates.some((statuses) => statuses.includes('AUTO_RETRY'))).toBe(true);
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
  });

  it('imports, deletes and locally exports selected fragment metadata', async () => {
    const imported = await importEffectSegmentRenderFiles(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      [{ name: '补充产品特写.mp4', size: 1024, type: 'video/mp4' }],
    );
    expect(imported.tasks[0]).toMatchObject({ source: 'IMPORTED', status: 'IMPORTED' });
    const exported = exportEffectSegmentRenderTasks(product('product-1'), [imported.tasks[0]!]);
    expect(exported.fileName).toBe('广式腊肠-AI视频片段-1条.json');
    await expect(exported.blob.text()).resolves.toContain('IMP-001');
    const deleted = await deleteEffectSegmentRenderTasks(
      context,
      product('product-1'),
      DEFAULT_EFFECT_VIDEO_CONFIG,
      [imported.tasks[0]!.id],
    );
    expect(deleted.tasks).toHaveLength(50);
  });
});
