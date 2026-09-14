import type { EffectSegmentRenderBatch } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  EFFECT_SEGMENT_RENDER_PAGE_SIZE,
  effectSegmentRenderPage,
  effectSegmentRenderPageCount,
  effectSegmentRenderCreativeCoreMap,
  effectSegmentRenderPromptDetailsMap,
  effectSegmentRenderSummary,
  effectSegmentRenderWorkspaceWithBatch,
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
  errorMessage: status === 'FAILED' ? '异常' : null,
  activeVersion: 1,
  repair: null,
  updatedAt: '2026-08-26T00:00:00.000Z',
});

describe('effect segment render state', () => {
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
