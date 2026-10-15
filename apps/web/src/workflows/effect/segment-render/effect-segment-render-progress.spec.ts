import { describe, expect, it } from 'vitest';
import { effectSegmentRenderProgress } from './effect-segment-render-progress';
import type { EffectSegmentRenderTask } from './effect-segment-render-state';

const task = (id: string, status = 'COMPLETED', progress = 100, independentImport = false) =>
  ({ id, status, progress, independentImport } as EffectSegmentRenderTask);
const old = Array.from({ length: 29 }, (_, index) => task(`old-${index}`));

describe('render progress is scoped to the current generation operation', () => {
  it('counts six video tasks and a completed removal as seven update items', () => {
    const tasks = [...old, ...Array.from({ length: 6 }, (_, i) => task(`video-${i}`, 'QUEUED', 0))];
    const state = { tasks, progressTaskIds: tasks.slice(29).map(({ id }) => id), progressRemovedCount: 1 };
    expect(effectSegmentRenderProgress(state)).toMatchObject({
      total: 7, completed: 1, progress: 14, detail: '已完成 1/7 项 · 视频 0/6 · 移除 1',
    });
    state.tasks[29] = task('video-0');
    expect(effectSegmentRenderProgress(structuredClone(state))).toMatchObject({ total: 7, completed: 2, progress: 29 });
    expect(effectSegmentRenderProgress(state, 7)).toMatchObject({ total: 7, completed: 0, progress: 0 });
  });
  it('counts pure synchronized changes and mixed failures without claiming all items completed', () => {
    expect(effectSegmentRenderProgress({ tasks: old, progressTaskIds: [], progressSynchronizedCount: 2 }))
      .toMatchObject({ total: 2, completed: 2, progress: 100 });
    expect(effectSegmentRenderProgress({ tasks: [task('failed', 'FAILED', 100)], progressTaskIds: ['failed'],
      progressSynchronizedCount: 1, progressRemovedCount: 1 }))
      .toMatchObject({ total: 3, completed: 2, progress: 99 });
  });
  it('starts at 0/1 while creating a local update instead of reading the old 100% batch', () => {
    expect(effectSegmentRenderProgress({ tasks: old }, 1)).toMatchObject({
      completed: 0, total: 1, progress: 0, detail: '正在创建任务，已完成 0/1 条',
    });
    expect(effectSegmentRenderProgress({ tasks: old }, 30)).toMatchObject({ total: 30, progress: 0 });
  });
  it('excludes the 29 unchanged clips and preserves partial completions after reload', () => {
    const state = { tasks: [...old, task('updated', 'QUEUED', 0), task('added', 'RENDERING', 0)],
      progressTaskIds: ['updated', 'added'] };
    expect(effectSegmentRenderProgress(state)).toMatchObject({ total: 2, completed: 0, progress: 0 });
    state.tasks[29] = task('updated');
    expect(effectSegmentRenderProgress(structuredClone(state))).toMatchObject({ total: 2, completed: 1, progress: 50 });
    state.tasks[30] = task('added');
    expect(effectSegmentRenderProgress(state)).toMatchObject({ total: 2, completed: 2, progress: 100 });
  });
  it('shows real task percentages and queue state, not the material pool completion ratio', () => {
    const state = { tasks: [...old, task('updated', 'QUEUED', 0)], progressTaskIds: ['updated'] };
    expect(effectSegmentRenderProgress(state)).toMatchObject({ total: 1, progress: 0,
      detail: '等待渲染，已完成 0/1 条' });
    state.tasks[29] = task('updated', 'RENDERING', 39);
    expect(effectSegmentRenderProgress(state)).toMatchObject({ total: 1, completed: 0, progress: 39 });
  });
  it('supports explicit import regeneration but excludes unrelated imports and free changes', () => {
    const tasks = [...old, task('import', 'RENDERING', 35, true), task('free-sync')];
    expect(effectSegmentRenderProgress({ tasks, progressTaskIds: ['import'] })).toMatchObject({ total: 1, progress: 35 });
    expect(effectSegmentRenderProgress({ tasks, progressTaskIds: [] })).toMatchObject({ total: 0, progress: 0 });
  });
  it('changes scope for a second update and does not carry progress across workspaces', () => {
    const tasks = [task('first'), task('second', 'QUEUED', 0)];
    expect(effectSegmentRenderProgress({ tasks, progressTaskIds: ['first'] }).progress).toBe(100);
    expect(effectSegmentRenderProgress({ tasks, progressTaskIds: ['second'] }).progress).toBe(0);
    expect(effectSegmentRenderProgress(null)).toMatchObject({ total: 0, progress: 0 });
  });
  it('never shows 100% for failures, nonfinite values or rounding before completion', () => {
    for (const [status, progress] of [['FAILED', 100], ['AUTO_RETRY', 100], ['RENDERING', 99.9], ['QUEUED', NaN]] as const)
      expect(effectSegmentRenderProgress({ tasks: [task('one', status, progress)] }).progress).toBeLessThan(100);
    expect(effectSegmentRenderProgress({ tasks: [task('one', 'FAILED', 100)] }).detail).toContain('异常 1 条');
  });
  it('supports legacy initial batches without the new optional field', () => {
    expect(effectSegmentRenderProgress({ tasks: [task('one', 'QUEUED', 0), task('two', 'QUEUED', 0),
      task('import', 'COMPLETED', 100, true)] })).toMatchObject({ total: 2, completed: 0, progress: 0 });
  });
});
