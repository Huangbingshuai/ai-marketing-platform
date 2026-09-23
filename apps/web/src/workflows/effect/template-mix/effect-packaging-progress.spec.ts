import { describe, expect, it } from 'vitest';
import type { PackagingItem, PackagingRun } from '@ai-marketing/contracts';
import { currentPackagingRun, packagingItemStageState, packagingProgress, packagingStageState } from './effect-packaging-progress';
import { PACKAGING_STAGES } from '@ai-marketing/contracts';
import component from './EffectTemplateMixPackaging.vue?raw';
import page from './EffectTemplateMixNodePage.vue?raw';

const item = (stage: PackagingItem['stage'], status: PackagingItem['status']) =>
  ({ stage, status }) as PackagingItem;
const run = (items: PackagingItem[]) => ({ items }) as PackagingRun;
describe('packaging workflow progress', () => {
  it('starts at zero without invented timer progress', () => {
    expect(packagingProgress()).toBe(0);
    expect(packagingProgress(run([item('SNAPSHOT', 'QUEUED')]))).toBe(0);
    expect(packagingStageState([], 'VOICE').label).toBe('等待中');
  });
  it('counts completed phases, not queued films as finished', () => {
    const value = run([
      item('READY', 'COMPLETED'),
      item('VOICE', 'RUNNING'),
      item('SNAPSHOT', 'QUEUED'),
    ]);
    expect(packagingProgress(value)).toBe(47);
    expect(packagingStageState(value.items, 'VOICE')).toMatchObject({
      completed: 1,
      running: 1,
      tone: 'running',
    });
    expect(packagingStageState(value.items, 'SCRIPT')).toMatchObject({
      completed: 2,
      label: '部分完成',
    });
  });
  it('preserves failed and cancelled stages without claiming completion', () => {
    expect(packagingStageState([item('MUSIC', 'FAILED')], 'MUSIC')).toMatchObject({
      completed: 0,
      failed: 1,
      tone: 'danger',
    });
    expect(packagingStageState([item('MUSIC', 'CANCELLED')], 'MUSIC').label).toBe('已取消');
    expect(packagingProgress(run([item('MUSIC', 'FAILED')]))).toBeLessThan(100);
  });
  it('only finishes when all persisted film stages finish', () => {
    expect(packagingProgress(run([item('READY', 'RUNNING')]))).toBe(85);
    const items = Array.from({ length: 100 }, () => item('READY', 'COMPLETED'));
    expect(packagingProgress(run(items))).toBe(100);
    expect(packagingStageState(items, 'READY')).toMatchObject({ completed: 100, tone: 'success' });
    for (const stage of PACKAGING_STAGES)
      expect(packagingStageState(items, stage)).toMatchObject({ completed: 100, failed: 0, running: 0, label: '已完成' });
  });
  it('shows parallel execution and failure counts without declaring the whole stage failed', () => {
    const items = [item('SCRIPT', 'FAILED'), item('SCRIPT', 'RUNNING'), item('VOICE', 'RUNNING'), item('VISION', 'RUNNING')];
    expect(packagingStageState(items, 'SCRIPT')).toMatchObject({
      completed: 1, running: 1, failed: 1, waiting: 1, tone: 'running', label: '执行中 · 1 条失败',
    });
    expect(packagingStageState(items, 'VOICE')).toMatchObject({ completed: 0, running: 1, blocked: 1, waiting: 2 });
    expect(packagingItemStageState(items[0]!, 'VOICE')).toBe('blocked');
  });
  it('clears old failures when persisted retry results complete', () => {
    const items = [item('VISION', 'FAILED'), item('SCRIPT', 'FAILED'), item('MUSIC', 'RUNNING')];
    expect(packagingStageState(items, 'VISION').failed).toBe(1);
    for (const value of items) { value.status = 'COMPLETED'; value.stage = 'READY'; }
    for (const stage of PACKAGING_STAGES)
      expect(packagingStageState(items, stage)).toMatchObject({ failed: 0, completed: 3, tone: 'success' });
  });
  it('distinguishes completed execution from invalidated source', () => {
    const value = { ...item('READY', 'COMPLETED'), stale: true };
    expect(packagingStageState([value], 'VOICE')).toMatchObject({ completed: 1, stale: 1, label: '来源待更新' });
  });
  it('uses the same latest or active batch instead of pinning a historical failure', () => {
    const old = { id: 'old', status: 'PARTIAL' } as PackagingRun;
    const latest = { id: 'new', status: 'COMPLETED' } as PackagingRun;
    expect(currentPackagingRun([latest, old])).toBe(latest);
    const running = { id: 'active', status: 'RUNNING' } as PackagingRun;
    expect(currentPackagingRun([latest, running, old])).toBe(running);
    expect(currentPackagingRun([])).toBeUndefined();
  });
  it('shares the fill progress component and graph styling with separate actions', () => {
    expect(component).toContain('WorkflowRunProgress');
    expect(component).toContain('action-label="查看当前工作流"');
    expect(component).toContain("if (mode === 'ACTION')");
    expect(component).not.toContain('确认并生成全部包装');
    expect(component).not.toContain('stage-graph');
    for (const source of [component, page])
      expect(source).toContain('src="./effect-template-mix-workflow.css"');
    expect(page.indexOf('src="./effect-template-mix-workflow.css"')).toBeGreaterThan(
      page.indexOf('</style>'),
    );
    expect(component).toContain('@click="selectedStage = stage"');
  });
  it('shows only node inputs and outputs in the packaging workflow', () => {
    expect(component).toContain('class="workflow-graph-canvas"');
    expect(component).toContain('class="workflow-detail-block is-input"');
    expect(component).toContain('class="workflow-detail-block is-output"');
    expect(component).toContain('已产出 {{ stageState(selectedStage).completed }} / {{ run.items.length }} 条');
    expect(component).not.toContain('class="packaging-run-summary"');
    expect(component).not.toContain('class="packaging-results"');
    expect(component).not.toContain('成片结果与分片进度');
    expect(component).not.toContain('class="stage-items"');
    expect(component).not.toContain('成片执行情况');
    expect(component).not.toContain('重做此槽位口播');
    expect(component).not.toContain('批量重做字幕');
  });
});
