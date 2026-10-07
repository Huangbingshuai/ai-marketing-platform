import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, nextTick, reactive } from 'vue';
import type { EffectWorkflowBranch, EffectWorkflowBranchTemplate, EffectWorkflowBranchTreeData } from '@ai-marketing/contracts';
import { branchStaleCounts, useEffectCanvasFreshness } from './effect-canvas-freshness';

const mocks = vi.hoisted(() => ({ tree: vi.fn(), artifacts: vi.fn(), sources: vi.fn(), output: vi.fn() }));
vi.mock('../../../platform/workflow/api/workflow-working.api', () => ({
  getEffectWorkflowBranchTree: mocks.tree, listWorkingArtifacts: mocks.artifacts,
}));
vi.mock('../template-mix/api/effect-template-mix.api', () => ({ loadEffectTemplateMixSources: mocks.sources }));
vi.mock('../../../api/http-client', () => ({ requestJson: mocks.output }));

const template = (templateId: string, stale: boolean): EffectWorkflowBranchTemplate => ({
  templateId, name: templateId, templateStatus: 'STALE', templateRevision: 1,
  fillRevision: 1, fillStatus: stale ? 'STALE' : 'CONFIRMED', timelineVariantCount: 3,
  packagingRevision: 1, packagingStatus: stale ? 'STALE' : 'CONFIRMED', packagingVariantCount: 3,
  deliveryRevision: 1, deliveryStatus: stale ? 'STALE' : 'CONFIRMED', deliveryCount: 1,
});
const branch = (workflowRunId: string, parentWorkflowRunId: string | null,
  item: EffectWorkflowBranchTemplate | null, createdAt: string): EffectWorkflowBranch => ({
  workflowRunId, parentWorkflowRunId, forkNodeId: parentWorkflowRunId ? 'TEMPLATE_MIX' : 'SEGMENT_RENDER',
  forkTemplateId: item?.templateId ?? null, forkMixStage: 'PACKAGING', creationKind: 'NODE_CHANGE',
  label: workflowRunId, createdAt, currentNodeId: 'SEGMENT_RENDER', isActive: workflowRunId === 'root',
  nodes: ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION', 'SEGMENT_RENDER'].map((nodeId) => ({
    nodeId: nodeId as EffectWorkflowBranch['nodes'][number]['nodeId'], status: 'CONFIRMED', artifactCount: 1,
  })), templates: item ? [item] : [],
});
const tree = (): EffectWorkflowBranchTreeData => ({ projectId: 'p', activeWorkflowRunId: 'root', branches: [
  branch('root', null, null, '2026-10-01'),
  branch('a-old', 'root', template('a', true), '2026-10-02'),
  branch('a', 'root', template('a', false), '2026-10-03'),
  branch('b', 'root', template('b', true), '2026-10-04'),
] });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  mocks.tree.mockResolvedValue({ data: tree() });
  mocks.artifacts.mockResolvedValue({ data: { items: [] } });
  mocks.sources.mockResolvedValue({ data: { pendingProjectCount: 0 } });
  mocks.output.mockResolvedValue({ data: [] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function mount(scope: { projectId: string; workflowRunId: string; activeStep: number; enabled: boolean;
  publishedWorkflowRunId?: string | null }) {
  let state!: ReturnType<typeof useEffectCanvasFreshness>;
  const renderer = createRenderer({ patchProp: () => {}, insert: () => {}, remove: () => {},
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText: () => {}, setElementText: () => {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp(defineComponent({ setup() {
    state = useEffectCanvasFreshness(() => scope); return () => null;
  } }));
  app.mount({});
  return { app, state };
}

describe('canvas confirmed branch projection', () => {
  it('includes the other current templates even when the active render or template branch is current', () => {
    expect(branchStaleCounts(tree(), 'root')).toEqual([0, 0, 0, 0, 1, 1]);
    expect(branchStaleCounts(tree(), 'a')).toEqual([0, 0, 0, 0, 1, 1]);
  });
  it('does not revive stale history when its current template path has been updated', () => {
    const data = tree();
    data.branches.find((item) => item.workflowRunId === 'b')!.templates[0] = template('b', false);
    expect(branchStaleCounts(data, 'root')).toEqual([0, 0, 0, 0, 0, 0]);
    expect(branchStaleCounts(data, 'a-old')?.[4]).toBe(1); // Explicit historical navigation remains valid.
  });
  it('isolates independent render heads and manual copies, and never fabricates ungenerated warnings', () => {
    const data = tree();
    data.branches.push(branch('other', null, template('c', true), '2026-10-05'));
    const copy = branch('copy', 'root', template('b', false), '2026-10-06');
    copy.creationKind = 'MANUAL_COPY'; copy.forkNodeId = null;
    data.branches.push(copy);
    expect(branchStaleCounts(data, 'root')?.[4]).toBe(1);
    expect(branchStaleCounts(data, 'copy')?.[4]).toBe(0);
    const unborn = template('d', true);
    unborn.timelineVariantCount = 0; unborn.packagingVariantCount = 0; unborn.deliveryCount = 0;
    data.branches.push(branch('unborn', 'root', unborn, '2026-10-07'));
    expect(branchStaleCounts(data, 'root')?.[4]).toBe(1);
    expect(branchStaleCounts(data, 'missing')).toBeNull();
  });
  it('uses actual upstream head statuses instead of inherited obsolete source copies', () => {
    const data = tree();
    data.branches[0]!.nodes[2]!.status = 'STALE';
    expect(branchStaleCounts(data, 'root')).toEqual([0, 0, 1, 0, 1, 1]);
  });
});

describe('canvas edit lifecycle', () => {
  it.each([0, 1, 2, 3])('keeps downstream warnings on node %i through enter, cancel and unchanged save', async (activeStep) => {
    const scope = reactive({ projectId: 'p', workflowRunId: 'root', activeStep, enabled: true,
      publishedWorkflowRunId: null as string | null });
    const { app, state } = mount(scope);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value.slice(4)).toEqual([1, 1]);
    for (const editId of ['cancel-draft', 'unchanged-save-draft']) {
      scope.workflowRunId = editId;
      scope.publishedWorkflowRunId = 'root';
      await nextTick();
      expect(state.staleCounts.value.slice(4)).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sources).toHaveBeenCalledWith('p', 'root', expect.any(AbortSignal));
      expect(mocks.sources.mock.calls.some(([, runId]) => runId === editId)).toBe(false);
      expect(state.staleCounts.value.slice(0, 4)).toEqual([0, 0, 0, 0]);
      scope.workflowRunId = 'root'; scope.publishedWorkflowRunId = null;
      await nextTick();
      expect(state.staleCounts.value.slice(4)).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.staleCounts.value.slice(4)).toEqual([1, 1]);
    }
    app.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('recalculates saved changes and clears warnings only when current downstream results actually become current', async () => {
    const scope = reactive({ projectId: 'p', workflowRunId: 'root', activeStep: 3, enabled: true,
      publishedWorkflowRunId: null as string | null });
    const { app, state } = mount(scope);
    await vi.advanceTimersByTimeAsync(0);
    scope.workflowRunId = 'changed-draft'; scope.publishedWorkflowRunId = 'root';
    await vi.advanceTimersByTimeAsync(0);
    const changed = tree(); changed.branches.find((item) => item.workflowRunId === 'a')!.templates[0] = template('a', true);
    mocks.tree.mockResolvedValue({ data: changed });
    scope.workflowRunId = 'root'; scope.publishedWorkflowRunId = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value.slice(4)).toEqual([2, 2]);
    const updated = tree(); updated.branches.find((item) => item.workflowRunId === 'b')!.templates[0] = template('b', false);
    mocks.tree.mockResolvedValue({ data: updated });
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value.slice(4)).toEqual([0, 0]);
    app.unmount();
  });
  it('does not clear known branch warnings on read failure or accept a late response after another project loads', async () => {
    const scope = reactive({ projectId: 'p', workflowRunId: 'root', activeStep: 3, enabled: true });
    const { app, state } = mount(scope);
    await vi.advanceTimersByTimeAsync(0);
    mocks.tree.mockRejectedValueOnce(new Error('temporary read failure'));
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value.slice(4)).toEqual([1, 1]);
    let resolveOld!: (value: unknown) => void;
    mocks.tree.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    await vi.advanceTimersByTimeAsync(12000);
    scope.projectId = 'other'; scope.workflowRunId = 'other-root';
    mocks.tree.mockResolvedValue({ data: { projectId: 'other', activeWorkflowRunId: 'other-root',
      branches: [branch('other-root', null, null, '2026-10-06')] } });
    await vi.advanceTimersByTimeAsync(0);
    resolveOld({ data: tree() }); await Promise.resolve(); await Promise.resolve();
    expect(state.staleCounts.value).toEqual([0, 0, 0, 0, 0, 0]);
    app.unmount();
  });
  it('counts additions only for their owning current template path, and does not count copied sibling drafts', async () => {
    const data = tree(); data.branches.find((item) => item.workflowRunId === 'b')!.templates[0] = template('b', false);
    mocks.tree.mockResolvedValue({ data });
    mocks.sources.mockImplementation((_projectId, runId) => Promise.resolve({ data: {
      pendingProjectCount: 9, // Obsolete copies in this Run are not current template heads.
      pendingAddedMaterialIds: runId === 'a' ? { b: ['wrong-path'] } : runId === 'b' ? { b: ['new'] } : {},
    } }));
    const scope = reactive({ projectId: 'p', workflowRunId: 'root', activeStep: 3, enabled: true });
    const { app, state } = mount(scope);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value.slice(4)).toEqual([1, 0]);
    mocks.sources.mockResolvedValue({ data: { pendingProjectCount: 9, pendingAddedMaterialIds: {} } });
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value.slice(4)).toEqual([0, 0]);
    app.unmount();
  });
  it('clears an old directory warning after a complete server reread but preserves a newer page projection', async () => {
    const data = tree(); data.branches.find((item) => item.workflowRunId === 'b')!.templates[0] = template('b', false);
    mocks.tree.mockResolvedValue({ data });
    const scope = reactive({ projectId: 'p', workflowRunId: 'root', activeStep: 3, enabled: true });
    const { app, state } = mount(scope);
    await vi.advanceTimersByTimeAsync(0);
    state.acceptMix({ projectId: 'p', workflowRunId: 'root', pendingProjectCount: 3 });
    expect(state.staleCounts.value[4]).toBe(3);
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value[4]).toBe(0);
    let resolveTree!: (value: unknown) => void;
    mocks.tree.mockImplementationOnce(() => new Promise((resolve) => { resolveTree = resolve; }));
    await vi.advanceTimersByTimeAsync(12000);
    state.acceptMix({ projectId: 'p', workflowRunId: 'root', pendingProjectCount: 2 });
    resolveTree({ data });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(2);
    app.unmount();
  });
});
