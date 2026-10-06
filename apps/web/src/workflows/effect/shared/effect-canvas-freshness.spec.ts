import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, nextTick, reactive } from 'vue';
import type { FinalOutputRun, WorkingArtifact } from '@ai-marketing/contracts';
import { artifactStaleCounts, outputStaleCount, useEffectCanvasFreshness } from './effect-canvas-freshness';
import canvas from '../source-import/components/EffectWorkflowCanvas.vue?raw';
import parent from '../source-import/EffectImportNodePage.vue?raw';

const mocks = vi.hoisted(() => ({ artifacts: vi.fn(), output: vi.fn(), sources: vi.fn() }));
vi.mock('../../../platform/workflow/api/workflow-working.api', () => ({ listWorkingArtifacts: mocks.artifacts }));
vi.mock('../../../api/http-client', () => ({ requestJson: mocks.output }));
vi.mock('../template-mix/api/effect-template-mix.api', () => ({ loadEffectTemplateMixSources: mocks.sources }));
const artifact = (id: string, nodeId: string, freshness = 'STALE') => ({ id, nodeId, freshness }) as WorkingArtifact;
const output = (templateId: string, stale: number) => ({ templateId, counts: { stale } }) as FinalOutputRun;
beforeEach(() => mocks.sources.mockResolvedValue({ data: { pendingProjectCount: 0 } }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('effect canvas update projection', () => {
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
    expect(canvas).toContain('<AlertCircle v-if="staleCount(index) > 0"');
    expect(canvas).toContain("? '待更新' : nodes[index]?.status");
    expect(canvas).not.toContain('待更新 · ${staleCount(index)}');
    expect(canvas).not.toContain('有 ${staleCount(index)} 项内容');
    expect(canvas).toContain("emit('select', index)");
    expect(parent).toContain(':stale-counts="canvasStaleCounts"');
    expect(parent).toContain('@freshness="canvasFreshness.acceptOutputs"');
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
    scope.workflowRunId = 'new';
    await nextTick();
    resolveOld({ data: { items: [artifact('old', 'FINAL_OUTPUT')] } });
    resolveOldSources({ data: { pendingProjectCount: 9 } });
    await Promise.resolve(); await Promise.resolve();
    expect(oldSignal?.aborted).toBe(true);
    expect(state.staleCounts.value).toEqual([0, 0, 0, 0, 0, 0]);
    state.acceptOutputs({ projectId: 'other', workflowRunId: 'new', runs: [output('a', 8)] });
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'old', runs: [output('a', 8)] });
    expect(state.staleCounts.value[5]).toBe(0);
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'new', runs: [output('a', 1)] });
    expect(state.staleCounts.value[5]).toBe(1);
    expect(mocks.output).not.toHaveBeenCalled();
    app.unmount();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    state.acceptOutputs({ projectId: 'p', workflowRunId: 'new', runs: [output('a', 9)] });
    expect(state.staleCounts.value[5]).toBe(1);
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
    channel.onmessage!({ data: { projectId: 'p', workflowRunId: 'w' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.output).toHaveBeenCalledTimes(5);
    expect(mocks.artifacts).toHaveBeenCalledTimes(3);
    app.unmount();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
