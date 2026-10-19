import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import type {
  ProductionDocument,
  ProductionTask,
  ProductionWorkspace,
} from '@ai-marketing/contracts';
import Workspace from './CustomizedProductionWorkspace.vue';
import { productionApi } from './production.api';
vi.mock('./production.api', () => ({
  productionApi: { workspace: vi.fn(), task: vi.fn() },
}));

type Host = { children: Host[]; parent: Host | null };
const node = (): Host => ({ children: [], parent: null });
const renderer = createRenderer<Host, Host>({
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  },
  parentNode: (child) => child.parent,
  nextSibling: () => null,
});
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await nextTick();
  }
};

it.each(['ASSETS', 'SHOTS'] as const)(
  '%s opens an untouched empty workspace without editing and restores only actual drafts',
  async (mode) => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const content: ProductionDocument = {
      assets: [
        {
          id: 'product',
          kind: 'PRODUCT',
          name: '充电器',
          description: '',
          knownFacts: '',
          designNotes: '',
          sourceText: '',
        },
      ],
      shots: [
        {
          id: 'shot',
          title: '产品亮相',
          shotType: '近景',
          cameraMovement: '固定',
          durationSeconds: 5,
          visual: '充电器置于桌面',
          dialogue: '',
          audio: '',
          atmosphere: '',
          bindings: [],
        },
      ],
    };
    for (const scenario of [
      {
        document: { assets: [], shots: [] },
        confirmed: { assets: [], shots: [] },
        confirmedFlag: false,
        editing: false,
      },
      {
        document: content,
        confirmed: { assets: [], shots: [] },
        confirmedFlag: false,
        editing: true,
      },
      { document: content, confirmed: content, confirmedFlag: true, editing: false },
      {
        document: { assets: [], shots: [] },
        confirmed: content,
        confirmedFlag: true,
        editing: true,
      },
    ]) {
      vi.mocked(productionApi.workspace).mockResolvedValue({
        script: {
          id: 'script',
          name: '充电器脚本',
          synopsis: '',
          structure: '',
          productFocus: '',
          shots: [],
        },
        source: { artifactId: 'script-artifact', revision: 1, fingerprint: 'confirmed' },
        sourceReady: true,
        document: scenario.document,
        confirmedDocument: scenario.confirmed,
        draftRevision: 1,
        assetsConfirmed: scenario.confirmedFlag,
        shotsConfirmed: scenario.confirmedFlag,
        prompts: [],
        tasks: [],
      } as ProductionWorkspace);
      let state: Record<string, unknown> = {};
      const app = renderer.createApp(
        {
          ...Workspace,
          render(this: { $: { setupState: Record<string, unknown> } }) {
            state = this.$.setupState;
            return h('div');
          },
        },
        { projectId: 'project', workflowRunId: 'run', mode },
      );
      app.provide(ssrContextKey, { modules: new Set() });
      app.mount(node());
      try {
        await settle();
        expect(state.editing).toBe(scenario.editing);
      } finally {
        app.unmount();
      }
    }
  },
);
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['ASSETS', 'SHOTS'],
  ['ASSETS', 'PROMPT'],
  ['SHOTS', 'ASSETS'],
  ['SHOTS', 'IMAGE'],
] as const)('%s does not display or lock on a running %s task', async (mode, operation) => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const task: ProductionTask = {
    id: 'other-node',
    operation,
    status: 'RUNNING',
    progress: 25,
    steps: [],
    shotId: null,
    errorMessage: null,
  };
  vi.mocked(productionApi.workspace).mockResolvedValue({
    script: {
      id: 'script',
      name: '充电器脚本',
      synopsis: '',
      structure: '',
      productFocus: '',
      shots: [],
    },
    source: { artifactId: 'script-artifact', revision: 1, fingerprint: 'confirmed' },
    sourceReady: true,
    document: { assets: [], shots: [] },
    confirmedDocument: { assets: [], shots: [] },
    draftRevision: 1,
    assetsConfirmed: true,
    shotsConfirmed: true,
    prompts: [],
    tasks: [task],
  } as ProductionWorkspace);
  vi.mocked(productionApi.task).mockResolvedValue(task);
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...Workspace,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    { projectId: 'project', workflowRunId: 'run', mode },
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    await settle();
    expect(state.running).toBeUndefined();
    expect(state.busy).toBe(false);
    expect(state.tasks).toEqual([]);
    expect(state.graphTask).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1800);
    await settle();
    if (operation === 'IMAGE') {
      // A video library image request refreshes silently, without video progress.
      expect(productionApi.task).toHaveBeenCalledWith(
        'project',
        'other-node',
        expect.any(AbortSignal),
      );
    } else expect(productionApi.task).not.toHaveBeenCalled();
    expect(state.running).toBeUndefined();
  } finally {
    app.unmount();
  }
});

it('recovers a failed progress read without failing the task or retaining a stale warning', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const task: ProductionTask = {
    id: 'task',
    operation: 'ASSETS',
    status: 'RUNNING',
    progress: 73,
    steps: [],
    shotId: null,
    errorMessage: null,
  };
  const initial = {
    script: {
      id: 'script',
      name: '充电器脚本',
      synopsis: '',
      structure: '',
      productFocus: '',
      shots: [],
    },
    source: { artifactId: 'script-artifact', revision: 1, fingerprint: 'confirmed' },
    sourceReady: true,
    document: { assets: [], shots: [] },
    confirmedDocument: { assets: [], shots: [] },
    draftRevision: 1,
    assetsConfirmed: false,
    shotsConfirmed: false,
    prompts: [],
    tasks: [task],
  } as ProductionWorkspace;
  const completed = { ...task, status: 'COMPLETED', progress: 100 } as const;
  vi.mocked(productionApi.workspace)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({ ...initial, tasks: [completed] });
  vi.mocked(productionApi.task)
    .mockRejectedValueOnce(new TypeError('network disconnected'))
    .mockResolvedValueOnce({ ...task, progress: 82 })
    .mockResolvedValueOnce(completed);
  let state: Record<string, unknown> = {};
  const component = {
    ...Workspace,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  };
  const app = renderer.createApp(component, {
    projectId: 'project',
    workflowRunId: 'run',
    mode: 'ASSETS',
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    await settle();
    await vi.advanceTimersByTimeAsync(1800);
    await settle();
    expect(state.error).toBe('');
    expect(state.pollingInterrupted).toBe(true);
    expect(state.running).toMatchObject({ id: 'task', status: 'RUNNING', progress: 73 });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(state.pollingInterrupted).toBe(false);
    expect(state.error).toBe('');
    expect(state.running).toMatchObject({ id: 'task', status: 'RUNNING', progress: 82 });
    await vi.advanceTimersByTimeAsync(1800);
    await settle();
    expect(state.running).toBeUndefined();
    expect(state.pollingInterrupted).toBe(false);
    expect(productionApi.task).toHaveBeenCalledTimes(3);
    expect(productionApi.workspace).toHaveBeenCalledTimes(2);
  } finally {
    app.unmount();
  }
  await vi.advanceTimersByTimeAsync(30000);
  expect(productionApi.task).toHaveBeenCalledTimes(3);
});
