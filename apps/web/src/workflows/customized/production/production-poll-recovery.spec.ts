import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import type { ProductionTask, ProductionWorkspace } from '@ai-marketing/contracts';
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
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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
