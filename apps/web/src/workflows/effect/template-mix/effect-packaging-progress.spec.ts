import { describe, expect, it } from 'vitest';
import type { PackagingItem, PackagingRun } from '@ai-marketing/contracts';
import { currentPackagingRun, packagingItemStageState, packagingProgress, packagingStageSamples, packagingStageState } from './effect-packaging-progress';
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
  it('shows up to four real, human-readable examples from packaging checkpoints', () => {
    const source = {
      slots: [{ id: 'slot-1', label: '产品展示', duration: 8 }],
      bindings: { 'slot-1': 'material-1' },
    };
    const actual = {
      name: '成片 01',
      stale: false,
      status: 'COMPLETED',
      sourceVisualTimeline: { ...source, offsets: { 'slot-1': 1.25 }, timelineStarts: { 'slot-1': 2 } },
      sourceClips: [{
        slotLabel: '产品展示', materialName: 'R-06 · 腊肠煎制', sourceOffset: 1.25,
        timelineStart: 2, duration: 8, transition: '叠化', transitionDuration: 0.5,
        originalAudioDetached: true,
      }],
      sourceFacts: [{ id: 'fact-1', text: '广式腊肠采用传统风干工艺' }],
      checkpoint: {
        vision: [{ slotId: 'slot-1', start: 0, end: 8, description: '木勺将食材放入盘中' }],
        script: [{ id: 'line-1', slotId: 'slot-1', text: '把美味轻松端上桌。', start: 0, end: 3, factIds: ['fact-1'] }],
        voices: { 'line-1': { fileObjectId: 'private-id', duration: 2.4, start: 0, volume: 1 } },
        musicBrief: '轻快温暖的纯音乐',
        music: { fileObjectId: 'private-id', duration: 8, start: 0, volume: 0.2 },
        captions: [{ id: 'caption-1', text: '把美味轻松端上桌。', start: 0.1, end: 2.4 }],
      },
    } as unknown as PackagingItem;
    expect(packagingStageSamples([actual], 'VISION')).toEqual({
      inputSamples: ['成片 01 · 分析产品展示 · R-06 · 腊肠煎制 · 原片 1.3–9.3 秒 · 成片 2.0–10.0 秒中的实际画面动作'],
      outputSamples: ['成片 01 · 产品展示：木勺将食材放入盘中'],
      audioPreviews: [],
    });
    expect(packagingStageSamples([actual], 'SNAPSHOT').outputSamples[0]).toContain(
      '已固定产品展示「R-06 · 腊肠煎制」在成片 2.0 秒开始，叠化 0.5 秒，原声已分离',
    );
    expect(packagingStageSamples([actual], 'SCRIPT').inputSamples[0]).toContain(
      '已确认商品依据：广式腊肠采用传统风干工艺',
    );
    expect(packagingStageSamples([actual], 'SCRIPT').outputSamples).toEqual([
      '成片 01 · 产品展示口播：「把美味轻松端上桌。」；依据：广式腊肠采用传统风干工艺',
    ]);
    expect(packagingStageSamples([actual], 'VOICE').outputSamples).toEqual([
      '成片 01 · 产品展示「把美味轻松端上桌。」 · 配音已生成，2.4 秒',
    ]);
    expect(packagingStageSamples([actual], 'VOICE').audioPreviews).toEqual([
      { label: '成片 01 · 产品展示配音试听', fileObjectId: 'private-id' },
    ]);
    expect(packagingStageSamples([actual], 'MUSIC').outputSamples[0]).toContain(
      '纯音乐已生成 · 配乐方向：「轻快温暖的纯音乐」',
    );
    expect(packagingStageSamples([actual], 'CAPTIONS').outputSamples).toEqual([
      '成片 01 · 把美味轻松端上桌。 · 0.1–2.4 秒',
    ]);
    expect(packagingStageSamples([actual], 'READY').outputSamples[0]).toContain(
      '口播：「把美味轻松端上桌。」 · 字幕：「把美味轻松端上桌。」 · 含纯音乐',
    );
    expect(JSON.stringify(packagingStageSamples([actual], 'VOICE').outputSamples)).not.toContain('private-id');
  });
  it('caps examples and hides samples whose source timeline is stale', () => {
    const slots = Array.from({ length: 7 }, (_, index) => ({ id: `slot-${index}`, label: `镜头 ${index}`, duration: 2 }));
    const current = {
      name: '成片样例', stale: false, status: 'RUNNING',
      sourceVisualTimeline: { slots, bindings: Object.fromEntries(slots.map((slot) => [slot.id, slot.id])) },
      checkpoint: { vision: slots.map((slot) => ({ slotId: slot.id, start: 0, end: 2, description: '画面内容' })) },
    } as unknown as PackagingItem;
    const stale = { ...current, stale: true };
    const samples = packagingStageSamples([current, stale], 'VISION');
    expect(samples.inputSamples).toHaveLength(4);
    expect(samples.outputSamples).toHaveLength(4);
    expect(samples.inputSamples.every((sample) => sample.startsWith('成片样例'))).toBe(true);
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
    expect(component).toContain('packagingStageSamples(run.value.items, selectedStage.value)');
    expect(component).toContain('本阶段输入示例（最多 4 项）');
    expect(component).toContain('本阶段结果示例（最多 4 项）');
    expect(component).toContain('阶段状态：{{ stageState(selectedStage).label }}');
    expect(component).toContain('selectedStageSamples.audioPreviews');
    expect(component).not.toContain('class="packaging-run-summary"');
    expect(component).not.toContain('class="packaging-results"');
    expect(component).not.toContain('成片结果与分片进度');
    expect(component).not.toContain('class="stage-items"');
    expect(component).not.toContain('成片执行情况');
    expect(component).not.toContain('重做此槽位口播');
    expect(component).not.toContain('批量重做字幕');
  });
});
