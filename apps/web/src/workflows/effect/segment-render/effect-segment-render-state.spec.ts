import type { EffectSegmentRenderBatch } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  EFFECT_SEGMENT_RENDER_PAGE_SIZE,
  effectSegmentRenderAdditionalPurposes,
  effectSegmentRenderCardTitle,
  effectSegmentRenderCurrentProductId,
  effectSegmentRenderPage,
  effectSegmentRenderPageCount,
  effectSegmentRenderCreativeCoreMap,
  effectSegmentRenderPromptDetailsMap,
  effectSegmentRenderSummary,
  effectSegmentRenderWorkspaceWithBatch,
  effectSegmentRenderWorkspaceFromApi,
  filterEffectSegmentRenderTasks,
  type EffectSegmentRenderTask,
} from './effect-segment-render-state';

const task = (
  index: number,
  status: EffectSegmentRenderTask['status'],
): EffectSegmentRenderTask => ({
  id: `task-${index}`,
  renderCode: `R-${String(index).padStart(3, '0')}`,
  productId: 'product-1',
  productName: '广式腊肠',
  promptId: `prompt-${index}`,
  promptCode: `P${index}`,
  promptText: `周末家庭厨房提示词 ${index}`,
  fragmentType: 'HOOK',
  compatibleFragmentTypes: ['PRODUCT_DISPLAY'],
  durationSeconds: 5,
  source: 'PROMPT',
  origin: 'AI_GENERATED',
  sourceName: `P${index}`,
  status,
  progress: status === 'COMPLETED' ? 100 : 50,
  retryCount: 0,
  maxAutoRetries: 2,
  abnormal: status === 'FAILED',
  needsUpdate: false,
  errorMessage: status === 'FAILED' ? '异常' : null,
  activeVersion: 1,
  repair: null,
  updatedAt: '2026-08-26T00:00:00.000Z',
});

describe('effect segment render state', () => {
  it('prefers a nonempty creative direction and keeps imported material independent of upstream IDs', () => {
    const material = { ...task(1, 'COMPLETED'), creativeCore: '  原创意方向  ' };
    expect(effectSegmentRenderCardTitle(material, ' 当前创意方向 ')).toBe('当前创意方向');
    expect(effectSegmentRenderCardTitle(material, '   ')).toBe('原创意方向');
    expect(effectSegmentRenderCardTitle({ ...material, independentImport: true }, '其他条目')).toBe('原创意方向');
  });

  it.each([
    ['【视频概览】\n目标： 展示锅中腊肠与蛋液。', '展示锅中腊肠与蛋液。'],
    ['  【视频概览】 目标: 展示产品\n细节。  ', '展示产品 细节。'],
    ['【视频概览】：\n目标 ： 展示商品。', '展示商品。'],
    ['【视频概览】展示商品。', '展示商品。'],
    ['目标：展示商品。', '展示商品。'],
    ['镜头扫过商品，目标：展示包装上的【视频概览】文字。', '镜头扫过商品，目标：展示包装上的【视频概览】文字。'],
  ])('uses the Prompt as the title, removing only leading labels: %s', (promptText, expected) => {
    const material = { ...task(1, 'COMPLETED'), creativeCore: '  ', promptText };
    expect(effectSegmentRenderCardTitle(material)).toBe(expected);
    expect(effectSegmentRenderCardTitle({ ...material, independentImport: true })).toBe(expected);
    expect(material.promptText).toBe(promptText);
  });

  it('falls back when the creative direction is absent and avoids blank titles for label-only input', () => {
    expect(effectSegmentRenderCardTitle(task(1, 'COMPLETED'))).toBe('周末家庭厨房提示词 1');
    expect(effectSegmentRenderCardTitle({ ...task(1, 'COMPLETED'), promptText: '【视频概览】\n目标：' })).toBe('P1');
  });

  it.each(['AI_GENERATED', 'EXTERNAL_IMPORT'] as const)(
    'shows only additional purposes for %s without changing the source classifications',
    (origin) => {
      const material = {
        ...task(1, 'COMPLETED'),
        origin,
        compatibleFragmentTypes: ['HOOK', 'EFFECT', 'PRODUCT_DISPLAY', 'EFFECT'] as EffectSegmentRenderTask['compatibleFragmentTypes'],
      };
      expect(effectSegmentRenderAdditionalPurposes(material)).toEqual(['EFFECT', 'PRODUCT_DISPLAY']);
      expect(material.compatibleFragmentTypes).toEqual(['HOOK', 'EFFECT', 'PRODUCT_DISPLAY', 'EFFECT']);
      material.fragmentType = 'EFFECT';
      expect(effectSegmentRenderAdditionalPurposes(material)).toEqual(['HOOK', 'PRODUCT_DISPLAY']);
    },
  );

  it('has no additional purposes when compatibility is empty or contains only the primary type', () => {
    expect(effectSegmentRenderAdditionalPurposes({ fragmentType: 'HOOK', compatibleFragmentTypes: [] })).toEqual([]);
    expect(effectSegmentRenderAdditionalPurposes({ fragmentType: 'HOOK', compatibleFragmentTypes: ['HOOK'] })).toEqual([]);
  });

  it.each(['新增混剪模板', '智能填充', '成片包装'])('%s 切换 Run 后重新匹配当前商品', () => {
    const nextProducts = [{ id: 'child-product', status: 'ACTIVE' as const }];
    expect(effectSegmentRenderCurrentProductId(nextProducts, 'parent-product')).toBe('child-product');
  });

  it('uses only the latest scope after multiple changes while the node is inactive', () => {
    const latest = [{ id: 'latest-product', status: 'ACTIVE' as const }];
    expect(effectSegmentRenderCurrentProductId(latest, 'first-product')).toBe('latest-product');
    expect(effectSegmentRenderCurrentProductId(latest, 'intermediate-product')).toBe('latest-product');
  });

  it('retains a selection still present in the current scope', () => {
    const products = [
      { id: 'first', status: 'ACTIVE' as const },
      { id: 'selected', status: 'ACTIVE' as const },
    ];
    expect(effectSegmentRenderCurrentProductId(products, 'selected')).toBe('selected');
  });

  it('never selects removed products or falls back to a cached branch when the current scope is empty', () => {
    expect(effectSegmentRenderCurrentProductId([], 'old-product')).toBe('');
    expect(effectSegmentRenderCurrentProductId([{ id: 'removed', status: 'REMOVED' }], 'removed')).toBe('');
    expect(effectSegmentRenderCurrentProductId([
      { id: 'removed', status: 'REMOVED' }, { id: 'current', status: 'ACTIVE' },
    ], 'removed')).toBe('current');
  });

  it('keeps new Prompt IDs pending without marking unchanged render tasks as changed', () => {
    const batch = {
      id: 'batch-1', productId: 'product-1',
      sourcePrompt: { artifactId: 'prompt-artifact', revision: 2, contentHash: 'a'.repeat(64) },
      revision: 2, status: 'COMPLETED', stale: true, refreshScope: 'SELECTIVE',
      pendingPromptIds: ['prompt-new'], commitStatus: 'UNCHANGED', workingArtifactRevision: 1,
      tasks: [{ ...task(1, 'COMPLETED'), compatiblePurposes: ['PRODUCT_DISPLAY'], output: null }],
      createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
    } as unknown as EffectSegmentRenderBatch;
    const current = effectSegmentRenderWorkspaceFromApi({
      projectId: 'project-1', workflowRunId: 'run-1', productId: 'product-1',
      promptCount: 2, promptReady: true, promptArtifactRevision: 2, settingsRevision: 1, batch,
    } as Parameters<typeof effectSegmentRenderWorkspaceFromApi>[0]);
    expect(current.pendingPromptIds).toEqual(['prompt-new']);
    expect(current.refreshScope).toBe('SELECTIVE');
    expect(current.tasks[0]?.needsUpdate).toBe(false);
    expect(effectSegmentRenderWorkspaceWithBatch(current, batch).pendingPromptIds).toEqual(['prompt-new']);
    const legacyBatch = { ...batch };
    delete legacyBatch.pendingPromptIds;
    expect(effectSegmentRenderWorkspaceWithBatch(current, legacyBatch).pendingPromptIds).toEqual([]);
    const refreshed = effectSegmentRenderWorkspaceWithBatch(current, { ...batch, latestPromptRevision: 7,
      latestPromptCount: 3, refreshSignature: 'net-difference', canSaveFrozenResults: true,
      autoCommitPending: true, progressTaskIds: ['task-1'] });
    expect(refreshed.promptArtifactRevision).toBe(7);
    expect(refreshed.sourcePromptRevision).toBe(2);
    expect(refreshed.autoCommitPending).toBe(true);
    expect(refreshed.progressTaskIds).toEqual(['task-1']);
    expect(effectSegmentRenderWorkspaceWithBatch(refreshed, legacyBatch).progressTaskIds).toBeUndefined();
    expect(effectSegmentRenderWorkspaceFromApi({ projectId: 'project-1', workflowRunId: 'run-1',
      productId: 'product-1', promptCount: 2, batch: { ...batch, progressTaskIds: ['task-1'] },
    } as Parameters<typeof effectSegmentRenderWorkspaceFromApi>[0]).progressTaskIds).toEqual(['task-1']);
    const adopted = effectSegmentRenderWorkspaceWithBatch(refreshed, { ...batch,
      autoCommitPending: false, committedWorkflowRunId: 'original-run' });
    expect(adopted.committedWorkflowRunId).toBe('original-run');
    expect(adopted.autoCommitPending).toBe(false);
    expect(effectSegmentRenderWorkspaceWithBatch(adopted, legacyBatch).committedWorkflowRunId).toBeUndefined();
    expect(refreshed.promptCount).toBe(3);
    expect(refreshed.refreshSignature).toBe('net-difference');
    expect(refreshed.canSaveFrozenResults).toBe(true);
  });
  it('preserves whether a completed slot came from AI generation or external import', () => {
    const current = {
      projectId: 'project-1',
      workflowRunId: 'run-1',
      productId: 'product-1',
      sourcePromptArtifactId: null,
      sourcePromptRevision: null,
      promptCount: 1,
      batchStatus: 'NOT_STARTED' as const,
      tasks: [],
      startedAt: null,
      completedAt: null,
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const imported = task(1, 'COMPLETED');
    imported.origin = 'EXTERNAL_IMPORT';
    const batch = {
      id: 'batch-1',
      projectId: current.projectId,
      workflowRunId: current.workflowRunId,
      productId: current.productId,
      productName: imported.productName,
      sourcePrompt: { artifactId: 'artifact-1', revision: 1, contentHash: 'a'.repeat(64) },
      status: 'COMPLETED',
      stale: false,
      refreshScope: 'NONE',
      revision: 2,
      commitStatus: 'DRAFT_CHANGED',
      workingArtifactRevision: 1,
      summary: { total: 1, completed: 1, running: 0, failed: 0 },
      tasks: [
        {
          ...imported,
          compatiblePurposes: imported.compatibleFragmentTypes,
          sourceName: 'P001-import.mp4',
          output: null,
          repair: null,
        },
      ],
      createdAt: current.updatedAt,
      updatedAt: current.updatedAt,
    } as EffectSegmentRenderBatch;

    expect(effectSegmentRenderWorkspaceWithBatch(current, batch).tasks[0]?.origin).toBe(
      'EXTERNAL_IMPORT',
    );
  });

  it('summarizes completed, running and abnormal tasks', () => {
    expect(
      effectSegmentRenderSummary([
        task(1, 'COMPLETED'),
        task(2, 'RENDERING'),
        task(3, 'AUTO_RETRY'),
        task(4, 'FAILED'),
      ]),
    ).toEqual({ total: 4, completed: 1, running: 2, failed: 1 });
  });

  it('filters by stable id, product and prompt content', () => {
    const tasks = [task(1, 'COMPLETED'), task(2, 'COMPLETED')];
    expect(filterEffectSegmentRenderTasks(tasks, 'R-001')).toHaveLength(1);
    expect(filterEffectSegmentRenderTasks(tasks, '提示词 2')).toHaveLength(1);
    expect(filterEffectSegmentRenderTasks(tasks, '广式腊肠')).toHaveLength(2);
    expect(
      filterEffectSegmentRenderTasks(tasks, '冰箱取出', {
        'prompt-1': '从冰箱取出产品并完成开盖动作',
      }),
    ).toHaveLength(1);
    expect(filterEffectSegmentRenderTasks(tasks, '不存在')).toEqual([]);
  });

  it('reads normalized creative directions from the confirmed prompt artifact', () => {
    expect(
      effectSegmentRenderCreativeCoreMap({
        items: [
          { id: 'prompt-1', creativeCore: '  冰箱取出产品\n并完成开盖动作  ' },
          { id: 'prompt-2', creativeCore: '' },
          { id: 3, creativeCore: '无效条目' },
        ],
      }),
    ).toEqual({ 'prompt-1': '冰箱取出产品 并完成开盖动作' });
    expect(effectSegmentRenderCreativeCoreMap(null)).toEqual({});
  });

  it('reads the creative direction and six dimensions from the confirmed prompt artifact', () => {
    expect(
      effectSegmentRenderPromptDetailsMap({
        items: [
          {
            id: 'prompt-1',
            creativeCore: '  家庭餐桌搭配\n展示  ',
            dimensions: {
              narrative: '效果展示型',
              scene: '家庭餐桌',
              persona: '家庭采购者',
              productRelation: '多种食物搭配',
              camera: '近景跟拍',
              emotion: '温馨自然',
            },
          },
          { id: 'prompt-2', creativeCore: '缺少六维信息' },
        ],
      }),
    ).toEqual({
      'prompt-1': {
        creativeCore: '家庭餐桌搭配 展示',
        dimensions: {
          narrative: '效果展示型',
          scene: '家庭餐桌',
          persona: '家庭采购者',
          productRelation: '多种食物搭配',
          camera: '近景跟拍',
          emotion: '温馨自然',
        },
      },
    });
  });

  it('uses twenty-item pages for four five-column rows and clamps the lower boundary', () => {
    const tasks = Array.from({ length: 41 }, (_, index) => task(index + 1, 'COMPLETED'));
    expect(EFFECT_SEGMENT_RENDER_PAGE_SIZE).toBe(20);
    expect(effectSegmentRenderPageCount(tasks.length)).toBe(3);
    expect(effectSegmentRenderPage(tasks, 1)).toHaveLength(20);
    expect(effectSegmentRenderPage(tasks, 3)).toHaveLength(1);
    expect(effectSegmentRenderPage(tasks, 0)[0]?.id).toBe('task-1');
  });
});
