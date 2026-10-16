import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, nextTick, reactive } from 'vue';
import type { EffectWorkflowBranchTreeData, FinalOutputRun, WorkingArtifact } from '@ai-marketing/contracts';
import { artifactStaleCounts, branchStaleCounts, outputStaleCount, useEffectCanvasFreshness } from './effect-canvas-freshness';
import canvas from '../source-import/components/EffectWorkflowCanvas.vue?raw';
import parent from '../source-import/EffectImportNodePage.vue?raw';

const mocks = vi.hoisted(() => ({ artifacts: vi.fn(), output: vi.fn(), sources: vi.fn(), tree: vi.fn() }));
vi.mock('../../../platform/workflow/api/workflow-working.api', () => ({ listWorkingArtifacts: mocks.artifacts,
  getEffectWorkflowBranchTree: mocks.tree }));
vi.mock('../../../api/http-client', () => ({ requestJson: mocks.output }));
vi.mock('../template-mix/api/effect-template-mix.api', () => ({ loadEffectTemplateMixSources: mocks.sources }));
const artifact = (id: string, nodeId: string, freshness = 'STALE') => ({ id, nodeId, freshness }) as WorkingArtifact;
const output = (templateId: string, stale: number) => ({ id: `output-${templateId}`, templateId,
  status: 'COMPLETED', counts: { stale }, items: [] }) as unknown as FinalOutputRun;
beforeEach(() => {
  mocks.sources.mockResolvedValue({ data: { pendingProjectCount: 0 } });
  mocks.tree.mockImplementation((projectId) => Promise.resolve({ data: { projectId, activeWorkflowRunId: null, branches: [] } }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('effect canvas update projection', () => {
  it('ignores obsolete active results but still aggregates real warnings from another current template', () => {
    const template = (templateId: string, fillStatus: string, currentConfirmedAt: string) => ({
      templateId, fillStatus, currentConfirmedAt, timelineVariantCount: 13,
      packagingVariantCount: 0, packagingStatus: 'PENDING', deliveryCount: 0,
    });
    const tree = { projectId: 'p', activeWorkflowRunId: 'old', branches: [
      { workflowRunId: 'current', parentWorkflowRunId: null, nodes: [], createdAt: '2026-10-01',
        templates: [template('a', 'CONFIRMED', '2026-10-07')] },
      { workflowRunId: 'old', parentWorkflowRunId: 'current', forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 'a', createdAt: '2026-10-02', nodes: [],
        templates: [template('a', 'STALE', '2026-10-03')] },
      { workflowRunId: 'other', parentWorkflowRunId: 'current', forkNodeId: 'TEMPLATE_MIX',
        forkTemplateId: 'b', createdAt: '2026-10-04', nodes: [],
        templates: [template('b', 'STALE', '2026-10-05')] },
    ] } as unknown as EffectWorkflowBranchTreeData;
    expect(branchStaleCounts(tree, 'old')?.[4]).toBe(1);
    tree.branches[2]!.templates[0]!.fillStatus = 'CONFIRMED';
    expect(branchStaleCounts(tree, 'old')?.[4]).toBe(0);
  });
  it('does not keep completed films stale because the template classified an older material pool', () => {
    expect(artifactStaleCounts([
      { ...artifact('pool', 'TEMPLATE_MIX'), artifactKey: 'mix-template:t', dependencies: [{
        sourceType: 'WORKING_ARTIFACT', sourceNodeId: 'SEGMENT_RENDER', sourceArtifactId: 'old',
        sourceRevision: 1,
      }] } as WorkingArtifact,
      { ...artifact('film', 'TEMPLATE_MIX', 'CURRENT'), artifactKey: 'timeline-project:t:v' },
    ])[4]).toBe(0);
    expect(artifactStaleCounts([
      { ...artifact('film', 'TEMPLATE_MIX'), artifactKey: 'timeline-project:t:v' },
      { ...artifact('package', 'TEMPLATE_MIX'), artifactKey: 'timeline-package:t:v' },
    ])[4]).toBe(2); // Real unfinished consumers still warn.
  });
  it('does not mark source heads stale just because a mix branch keeps outdated input copies', () => {
    expect(artifactStaleCounts([
      { ...artifact('copy', 'SEGMENT_RENDER'), metadata: { branchSourceOwner: false } },
      { ...artifact('prompt-copy', 'PROMPT_GENERATION'), metadata: { branchSourceOwner: false } },
      { ...artifact('head', 'SEGMENT_RENDER', 'CURRENT'), metadata: { branchSourceOwner: true } },
      artifact('affected-mix', 'TEMPLATE_MIX'),
    ])).toEqual([0, 0, 0, 0, 1, 0]);
    expect(artifactStaleCounts([
      { ...artifact('stale-head', 'SEGMENT_RENDER'), metadata: { branchSourceOwner: true } },
    ])[3]).toBe(1); // A real upstream Prompt change still invalidates its render result.
  });
  it('counts only actual stale artifacts, normalizes node IDs and deduplicates inherited IDs', () => {
    expect(artifactStaleCounts([
      artifact('a', 'PROMPT_GENERATION:p'), artifact('a', 'PROMPT_GENERATION:p'),
      artifact('b', 'SEGMENT_RENDER_SETTINGS:p'), artifact('c', 'TEMPLATE_MIX:t'),
      artifact('d', 'FINAL_OUTPUT:t', 'FRESH'), artifact('e', 'UNKNOWN'),
    ])).toEqual([0, 0, 1, 1, 1, 0]);
    expect(artifactStaleCounts([])).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('uses only each template current batch, not stale historical files', () => {
    expect(outputStaleCount([output('a', 2), output('b', 0), output('a', 7), output('b', 9)]))
      .toBe(2);
  });
  it('never lets a background export replace source-branch update warnings', () => {
    expect(outputStaleCount([
      { ...output('a', 0), backgroundExportSourceRunId: 'source' }, output('a', 2),
      { ...output('b', 8), backgroundExportSourceRunId: 'other' }, output('b', 1),
    ])).toBe(3);
  });
  it('shows a non-color update warning without exposing artifact counts or changing navigation', () => {
    expect(canvas).toContain('needs-update');
    expect(canvas).toMatch(/<AlertCircle\s+v-if="staleCount\(index\) > 0"/);
    expect(canvas).toMatch(/staleCount\(index\) > 0\s*\? '待更新'/);
    expect(canvas).not.toContain('待更新 · ${staleCount(index)}');
    expect(canvas).not.toContain('有 ${staleCount(index)} 项内容');
    expect(canvas).toContain("emit('select', index)");
    expect(parent).toContain(':stale-counts="canvasStaleCounts"');
    expect(parent).toContain('@freshness="canvasFreshness.acceptOutputs"');
    expect(parent).toContain('@mix-freshness="canvasFreshness.acceptMix"');
  });
  it('rejects late reads from another run, resets warnings, reuses visible output polling and cleans up', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    const listeners = new Map();
    vi.stubGlobal('window', { addEventListener: vi.fn((name, fn) => listeners.set(name, fn)),
      removeEventListener: vi.fn((name) => listeners.delete(name)) });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    let resolveOld!: (value: unknown) => void;
    let resolveOldSources!: (value: unknown) => void;
    let oldSignal: AbortSignal | undefined;
    mocks.sources.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOldSources = resolve;
    }));
    mocks.artifacts.mockImplementationOnce((_id, _query, signal) => {
      oldSignal = signal;
      return new Promise((resolve) => { resolveOld = resolve; });
    }).mockResolvedValue({ data: { items: [] } });
    const scope = reactive({ projectId: 'p', workflowRunId: 'old', activeStep: 5, enabled: true });
    let state!: ReturnType<typeof useEffectCanvasFreshness>;
    // Minimal Vue renderer supplies genuine mount/unmount lifecycle without a DOM dependency.
    const renderer = createRenderer({
      patchProp: () => {}, insert: () => {}, remove: () => {},
      createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
      setText: () => {}, setElementText: () => {}, parentNode: () => null, nextSibling: () => null,
    });
    const app = renderer.createApp(defineComponent({ setup() {
      state = useEffectCanvasFreshness(() => scope); return () => null;
    } }));
    app.mount({});
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'old', runs: [output('a', 3)] });
    expect(state.staleCounts.value[5]).toBe(3);
    scope.activeStep = 4;
    state.acceptMix({ projectId: 'p', workflowRunId: 'old', pendingProjectCount: 2 });
    expect(state.staleCounts.value[4]).toBe(2);
    scope.workflowRunId = 'new';
    scope.activeStep = 5;
    await nextTick();
    resolveOld({ data: { items: [artifact('old', 'FINAL_OUTPUT')] } });
    resolveOldSources({ data: { pendingProjectCount: 9 } });
    await Promise.resolve(); await Promise.resolve();
    expect(oldSignal?.aborted).toBe(true);
    expect(state.staleCounts.value).toEqual([0, 0, 0, 0, 0, 0]);
    state.acceptOutputs({ projectId: 'other', workflowRunId: 'new', runs: [output('a', 8)] });
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'old', runs: [output('a', 8)] });
    expect(state.staleCounts.value[5]).toBe(0);
    scope.activeStep = 4;
    state.acceptMix({ projectId: 'other', workflowRunId: 'new', pendingProjectCount: 8 });
    state.acceptMix({ projectId: 'p', workflowRunId: 'old', pendingProjectCount: 8 });
    expect(state.staleCounts.value[4]).toBe(0);
    state.acceptMix({ projectId: 'p', workflowRunId: 'new', pendingProjectCount: 4 });
    expect(state.staleCounts.value[4]).toBe(4);
    scope.activeStep = 5;
    expect(state.staleCounts.value[4]).toBe(4); // Leaving the mix page cannot clear its known warning.
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'new', runs: [output('a', 1)] });
    expect(state.staleCounts.value[5]).toBe(1);
    expect(mocks.output).not.toHaveBeenCalled();
    app.unmount();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'new', runs: [output('a', 9)] });
    expect(state.staleCounts.value[5]).toBe(1);
    scope.activeStep = 4;
    state.acceptMix({ projectId: 'p', workflowRunId: 'new', pendingProjectCount: 9 });
    expect(state.staleCounts.value[4]).toBe(4);
  });
  it('refreshes immediately on saved changes in this or another tab, isolates scope and releases subscriptions', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    const channel = { onmessage: null as null | ((event: { data: unknown }) => void), close: vi.fn() };
    vi.stubGlobal('BroadcastChannel', vi.fn(function () { return channel; }));
    vi.stubGlobal('window', { addEventListener: vi.fn((name, fn) => listeners.set(name, fn)),
      removeEventListener: vi.fn((name) => listeners.delete(name)) });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    mocks.artifacts.mockResolvedValue({ data: { items: [] } });
    mocks.output.mockResolvedValue({ data: [output('t', 0)] });
    mocks.sources.mockResolvedValue({ data: { pendingProjectCount: 2 } });
    let state!: ReturnType<typeof useEffectCanvasFreshness>;
    const renderer = createRenderer({
      patchProp: () => {}, insert: () => {}, remove: () => {},
      createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
      setText: () => {}, setElementText: () => {}, parentNode: () => null, nextSibling: () => null,
    });
    const app = renderer.createApp(defineComponent({ setup() {
      state = useEffectCanvasFreshness(() => ({ projectId: 'p', workflowRunId: 'w', activeStep: 4, enabled: true }));
      return () => null;
    } }));
    app.mount({});
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.output).toHaveBeenCalledTimes(1);
    expect(state.staleCounts.value[4]).toBe(2); // Replacement IDs need no old STALE graph edge.
    listeners.get('effect-final-output-sync')!({ detail: { projectId: 'other', workflowRunId: 'w' } });
    channel.onmessage!({ data: { projectId: 'p', workflowRunId: 'old' } });
    expect(mocks.output).toHaveBeenCalledTimes(1);
    mocks.output.mockResolvedValue({ data: [output('t', 1)] });
    mocks.sources.mockResolvedValue({ data: { pendingProjectCount: 0 } });
    listeners.get('effect-final-output-sync')!({ detail: { projectId: 'p', workflowRunId: 'w' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.output).toHaveBeenCalledTimes(2);
    expect(state.staleCounts.value[5]).toBe(1);
    expect(state.staleCounts.value[4]).toBe(0);
    expect(mocks.artifacts).toHaveBeenCalledTimes(1); // Saved drafts do not reconfirm artifacts.
    mocks.artifacts.mockResolvedValue({ data: { items: [artifact('stale-film', 'TEMPLATE_MIX')] } });
    listeners.get('effect-final-output-sync')!({ detail: { projectId: 'p', workflowRunId: 'w', confirmed: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.artifacts).toHaveBeenCalledTimes(2);
    expect(state.staleCounts.value[4]).toBe(1);
    mocks.artifacts.mockResolvedValue({ data: { items: [] } });
    listeners.get('effect-final-output-sync')!({ detail: { projectId: 'p', workflowRunId: 'w', confirmed: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.artifacts).toHaveBeenCalledTimes(3);
    expect(state.staleCounts.value[4]).toBe(0);
    state.acceptMix({ projectId: 'p', workflowRunId: 'w', pendingProjectCount: 6 });
    listeners.get('effect-final-output-sync')!({ detail: { projectId: 'p', workflowRunId: 'w' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(6); // Single-run polling cannot erase the all-template directory warning.
    state.acceptMix({ projectId: 'p', workflowRunId: 'w', pendingProjectCount: 0 });
    expect(state.staleCounts.value[4]).toBe(0);
    channel.onmessage!({ data: { projectId: 'p', workflowRunId: 'w' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.output).toHaveBeenCalledTimes(7);
    expect(mocks.artifacts).toHaveBeenCalledTimes(4); // Directory completion immediately reconciles confirmations.
    app.unmount();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rechecks branch freshness as soon as the last locally updated film completes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const branch = (fillStatus: 'STALE' | 'CONFIRMED') => ({ data: {
      projectId: 'p', activeWorkflowRunId: 'w', branches: [{ workflowRunId: 'w', nodes: [], templates: [{
        templateId: 't', timelineVariantCount: 1, fillStatus, packagingVariantCount: 0,
        packagingStatus: 'PENDING', deliveryCount: 0, deliveryStatus: 'PENDING',
      }] }],
    } });
    mocks.tree.mockResolvedValueOnce(branch('STALE') as never).mockResolvedValue(branch('CONFIRMED') as never);
    mocks.sources.mockResolvedValue({ data: { pendingProjectCount: 0 } });
    mocks.artifacts.mockResolvedValue({ data: { items: [] } });
    mocks.output.mockResolvedValue({ data: [] });
    let state!: ReturnType<typeof useEffectCanvasFreshness>;
    const renderer = createRenderer({
      patchProp: () => {}, insert: () => {}, remove: () => {},
      createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
      setText: () => {}, setElementText: () => {}, parentNode: () => null, nextSibling: () => null,
    });
    const app = renderer.createApp(defineComponent({ setup() {
      state = useEffectCanvasFreshness(() => ({ projectId: 'p', workflowRunId: 'w', activeStep: 4, enabled: true }));
      return () => null;
    } }));
    app.mount({});
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(1);
    const queued = { ...output('t', 1), status: 'QUEUED', items: [{ id: 'film', status: 'QUEUED', stale: true }] } as unknown as FinalOutputRun;
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'w', runs: [queued] });
    const completed = { ...output('t', 0), items: [{ id: 'film', status: 'COMPLETED', stale: false }] } as unknown as FinalOutputRun;
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'w', runs: [completed] });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.tree).toHaveBeenCalledTimes(2);
    expect(state.staleCounts.value[4]).toBe(0);
    expect(state.branchTree.value?.branches[0]?.templates[0]?.fillStatus).toBe('CONFIRMED');
    app.unmount();
  });
});
