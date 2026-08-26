import { describe, expect, it } from 'vitest';

import {
  EFFECT_SEGMENT_RENDER_PAGE_SIZE,
  effectSegmentRenderPage,
  effectSegmentRenderPageCount,
  effectSegmentRenderSummary,
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
  materialTags: ['钩子片段', index % 2 ? '家庭' : '户外'],
  durationSeconds: 5,
  modelMatch: 'AUTO_MATCHED',
  source: 'PROMPT',
  sourceName: `P${index}`,
  status,
  progress: status === 'COMPLETED' ? 100 : 50,
  retryCount: 0,
  maxAutoRetries: 2,
  abnormal: status === 'FAILED',
  errorMessage: status === 'FAILED' ? '异常' : null,
  updatedAt: '2026-08-26T00:00:00.000Z',
});

describe('effect segment render state', () => {
  it('summarizes completed, running and abnormal tasks', () => {
    expect(
      effectSegmentRenderSummary([
        task(1, 'COMPLETED'),
        task(2, 'IMPORTED'),
        task(3, 'RENDERING'),
        task(4, 'AUTO_RETRY'),
        task(5, 'FAILED'),
      ]),
    ).toEqual({ total: 5, completed: 2, running: 2, failed: 1 });
  });

  it('filters by stable id, product, prompt content and tags', () => {
    const tasks = [task(1, 'COMPLETED'), task(2, 'COMPLETED')];
    expect(filterEffectSegmentRenderTasks(tasks, 'R-001')).toHaveLength(1);
    expect(filterEffectSegmentRenderTasks(tasks, '户外')).toHaveLength(1);
    expect(filterEffectSegmentRenderTasks(tasks, '广式腊肠')).toHaveLength(2);
    expect(filterEffectSegmentRenderTasks(tasks, '不存在')).toEqual([]);
  });

  it('uses twelve-item pages and safely clamps the lower page boundary', () => {
    const tasks = Array.from({ length: 25 }, (_, index) => task(index + 1, 'COMPLETED'));
    expect(EFFECT_SEGMENT_RENDER_PAGE_SIZE).toBe(12);
    expect(effectSegmentRenderPageCount(tasks.length)).toBe(3);
    expect(effectSegmentRenderPage(tasks, 1)).toHaveLength(12);
    expect(effectSegmentRenderPage(tasks, 3)).toHaveLength(1);
    expect(effectSegmentRenderPage(tasks, 0)[0]?.id).toBe('task-1');
  });
});
