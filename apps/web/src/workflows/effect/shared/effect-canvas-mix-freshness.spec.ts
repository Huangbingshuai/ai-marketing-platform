import type {
  EffectTemplateMixSourcesData,
  EffectWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import { createRenderer, defineComponent, nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentMixSourceCount, useEffectCanvasFreshness } from './effect-canvas-freshness';

const mocks = vi.hoisted(() => ({
  artifacts: vi.fn(),
  output: vi.fn(),
  sources: vi.fn(),
  tree: vi.fn(),
}));
vi.mock('../../../platform/workflow/api/workflow-working.api', () => ({
  listWorkingArtifacts: mocks.artifacts,
  getEffectWorkflowBranchTree: mocks.tree,
}));
vi.mock('../../../api/http-client', () => ({ requestJson: mocks.output }));
vi.mock('../template-mix/api/effect-template-mix.api', () => ({
  loadEffectTemplateMixSources: mocks.sources,
}));
const tree = (): EffectWorkflowBranchTreeData =>
  ({
    projectId: 'p',
    activeWorkflowRunId: 'w',
    branches: [
      {
        workflowRunId: 'w',
        parentWorkflowRunId: null,
        nodes: [],
        createdAt: '2026-10-01',
        templates: [
          {
            templateId: 't',
            timelineVariantCount: 17,
            fillStatus: 'STALE',
            packagingVariantCount: 17,
            packagingStatus: 'STALE',
            deliveryCount: 0,
            currentConfirmedAt: '2026-10-08',
          },
        ],
      },
    ],
  }) as unknown as EffectWorkflowBranchTreeData;
const sources = (count: number): EffectTemplateMixSourcesData => ({
  materials: [],
  draftRevision: 1,
  pendingProjectCounts: { t: count },
  pendingProjectCount: count,
  pendingAddedMaterialIds: { t: [] },
});
const renderer = createRenderer({
  patchProp: () => {},
  insert: () => {},
  remove: () => {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText: () => {},
  setElementText: () => {},
  parentNode: () => null,
  nextSibling: () => null,
});
const mount = () => {
  const scope = reactive({ projectId: 'p', workflowRunId: 'w', activeStep: 4, enabled: true });
  let state!: ReturnType<typeof useEffectCanvasFreshness>;
  const app = renderer.createApp(
    defineComponent({
      setup() {
        state = useEffectCanvasFreshness(() => scope);
        return () => null;
      },
    }),
  );
  app.mount({});
  return { app, scope, state };
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mocks.tree.mockResolvedValue({ data: tree() });
  mocks.sources.mockResolvedValue({ data: sources(0) });
  mocks.artifacts.mockResolvedValue({ data: { items: [] } });
  mocks.output.mockResolvedValue({ data: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('mix canvas and template directory agree', () => {
  it('does not publish copied artifact warnings while the first current-path source read is still pending', async () => {
    let resolveSources!: (value: unknown) => void;
    mocks.sources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSources = resolve;
        }),
    );
    mocks.artifacts.mockResolvedValue({
      data: {
        items: [
          {
            id: 'copied-timeline',
            nodeId: 'TEMPLATE_MIX',
            artifactKey: 'timeline-project:t:old',
            freshness: 'STALE',
          },
        ],
      },
    });
    const { app, state } = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(0);
    resolveSources({ data: sources(0) });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(0);
    // Waiting for a complete read must not suppress a real subsequent source change.
    mocks.sources.mockResolvedValue({ data: sources(2) });
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value[4]).toBe(2);
    app.unmount();
  });

  it('clears stale fill/package graph flags when actual current projects are synchronized, even off the mix page', async () => {
    const { app, scope, state } = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(0);
    scope.activeStep = 1;
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(0);
    // A later source change must still warn, without visiting the template page.
    mocks.sources.mockResolvedValue({ data: sources(3) });
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value[4]).toBe(3);
    mocks.sources.mockResolvedValue({ data: sources(0) });
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value[4]).toBe(0);
    app.unmount();
  });

  it('accepts directory zero immediately and does not restore a warning from a late earlier read', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.sources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { app, state } = mount();
    state.acceptMix({ projectId: 'p', workflowRunId: 'w', pendingProjectCount: 0 });
    expect(state.staleCounts.value[4]).toBe(0);
    resolveOld({ data: sources(5) });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(0);
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value[4]).toBe(0);
    app.unmount();
  });

  it('keeps known warnings on failed reads, but does not carry them into another project', async () => {
    mocks.sources.mockResolvedValue({ data: sources(2) });
    const { app, scope, state } = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(2);
    mocks.sources.mockRejectedValue(new Error('temporary unavailable'));
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value[4]).toBe(2);
    scope.projectId = 'other';
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.staleCounts.value[4]).toBe(0);
    app.unmount();
  });

  it('counts only each current template path, not historical copied templates or aggregate run counts', () => {
    const value = tree();
    value.branches.push({
      ...value.branches[0]!,
      workflowRunId: 'b',
      parentWorkflowRunId: 'w',
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: 'other',
      createdAt: '2026-10-02',
      templates: [
        {
          ...value.branches[0]!.templates[0]!,
          templateId: 'other',
          currentConfirmedAt: '2026-10-08',
        },
      ],
    });
    const pools = new Map<string, EffectTemplateMixSourcesData>([
      ['w', { ...sources(0), pendingProjectCount: 9, pendingProjectCounts: { t: 0, old: 9 } }],
      [
        'b',
        {
          ...sources(2),
          pendingProjectCounts: { other: 2, t: 7 },
          pendingAddedMaterialIds: { other: ['new'] },
        },
      ],
    ]);
    expect(currentMixSourceCount(value, 'w', pools)).toBe(3);
    pools.set('b', {
      ...sources(0),
      pendingProjectCounts: { other: 0 },
      pendingAddedMaterialIds: {},
    });
    expect(currentMixSourceCount(value, 'w', pools)).toBe(0);
  });

  it('does not mistake missing old-API fields or unknown contexts for confirmed zeros', () => {
    expect(
      currentMixSourceCount(
        tree(),
        'w',
        new Map([
          [
            'w',
            {
              materials: [],
              draftRevision: null,
              pendingProjectCount: 0,
            },
          ],
        ]),
      ),
    ).toBeNull();
    expect(currentMixSourceCount(tree(), 'missing', new Map())).toBeNull();
  });

  it('does not clear a known directory warning using incomplete compatibility responses', async () => {
    const { app, state } = mount();
    await vi.advanceTimersByTimeAsync(0);
    state.acceptMix({ projectId: 'p', workflowRunId: 'w', pendingProjectCount: 2 });
    mocks.sources.mockResolvedValue({
      data: { materials: [], draftRevision: 1, pendingProjectCount: 0 },
    });
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.staleCounts.value[4]).toBe(2);
    app.unmount();
  });
});
