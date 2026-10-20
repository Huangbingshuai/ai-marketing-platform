import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import type {
  CustomizedWorkflowBranchTreeData,
  CustomizedWorkflowBranch,
  StoryboardWorkspace,
} from '@ai-marketing/contracts';
import Page from './source-import/CustomizedImportNodePage.vue';
import {
  customizedProductionNavigationRun,
  customizedScriptRun,
  customizedScriptSelectionRun,
} from './customized-production-navigation';
const api = vi.hoisted(() => ({
  overview: vi.fn(),
  tree: vi.fn(),
  activate: vi.fn(),
  node: vi.fn(),
  list: vi.fn(),
  put: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('../../platform/project/project-context', () => ({
  useProjectContext: () => ({ currentProject: { value: { id: 'project', name: '测试项目' } } }),
}));
vi.mock('../../platform/workflow/api/workflow-working.api', () => ({
  getActiveWorkflowRunOverview: api.overview,
  activateWorkflowNode: api.node,
  listWorkingArtifacts: api.list,
  putWorkflowNodeState: api.put,
}));
vi.mock('./source-import/api/customized-import.api', () => ({
  getCustomizedBranchTree: api.tree,
  activateCustomizedBranch: api.activate,
}));
vi.mock('./storyboard/storyboard.api', () => ({ storyboardApi: { workspace: api.catalog } }));

function branch(
  id: string,
  parent: string | null,
  fork: CustomizedWorkflowBranch['forkNodeId'],
): CustomizedWorkflowBranch {
  return {
    workflowRunId: id,
    parentWorkflowRunId: parent,
    forkNodeId: fork,
    label: id,
    currentNodeId: 'SHOT_PROMPT',
    createdAt: '',
    isActive: id === 'assets',
    nodes: [],
  };
}
const tree: CustomizedWorkflowBranchTreeData = {
  projectId: 'project',
  activeWorkflowRunId: 'assets',
  branches: [
    branch('brief', null, 'INFORMATION_EXTRACTION'),
    branch('script', 'brief', 'STORYBOARD'),
    branch('assets', 'script', 'SHOT_PROMPT'),
    branch('video', 'assets', 'SHOT_RENDER'),
    branch('other-script', 'brief', 'STORYBOARD'),
  ],
};
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
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
const cleanups: (() => void)[] = [];
async function mount() {
  let state: Record<string, unknown> = {};
  const app = renderer.createApp({
    ...Page,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanups.push(() => app.unmount());
  await settle();
  return state;
}
const call = (state: Record<string, unknown>, method: string, ...args: unknown[]) =>
  (state[method] as (...args: unknown[]) => Promise<unknown>)(...args);
function catalog(scriptRunId = 'script'): StoryboardWorkspace {
  return {
    selectedScriptId: 'selected',
    scripts: [
      {
        id: 'selected',
        workflowRunId: scriptRunId,
        confirmedRevision: 1,
        stale: false,
        editing: false,
      },
    ],
  } as unknown as StoryboardWorkspace;
}
beforeEach(() => {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    scrollTo: vi.fn(),
    scrollY: 0,
  });
  api.overview.mockResolvedValue({
    data: {
      run: {
        id: 'assets',
        projectId: 'project',
        workflow: 'CUSTOMIZED',
        workflowSpace: 'CUSTOMIZED_PROJECT',
        currentNodeId: 'SHOT_PROMPT',
      },
      nodeStates: [],
    },
  });
  api.tree.mockResolvedValue({ data: tree });
  api.list.mockResolvedValue({ data: { items: [] } });
  api.catalog.mockResolvedValue(catalog());
  api.node.mockResolvedValue({});
  api.activate.mockResolvedValue({});
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe('ordinary customized production navigation', () => {
  it('resolves selected script paths using current, remembered, then latest valid descendants', () => {
    const data = {
      ...tree,
      branches: [
        ...tree.branches,
        { ...branch('other-assets', 'other-script', 'SHOT_PROMPT'), createdAt: '2026-10-19' },
        { ...branch('other-assets-2', 'other-script', 'SHOT_PROMPT'), createdAt: '2026-10-20' },
      ],
    };
    expect(customizedScriptRun(data, 'video')).toBe('script');
    expect(customizedScriptSelectionRun(data, 'video', 'script', 'assets')).toBe('video');
    expect(customizedScriptSelectionRun(data, 'assets', 'other-script')).toBe('other-assets-2');
    expect(customizedScriptSelectionRun(data, 'assets', 'other-script', 'other-assets')).toBe(
      'other-assets',
    );
    expect(customizedScriptSelectionRun(data, 'assets', 'other-script', 'video')).toBe(
      'other-assets-2',
    );
    expect(customizedScriptSelectionRun(data, 'assets', 'missing-script', 'deleted')).toBe(
      'missing-script',
    );
    expect(
      customizedScriptRun({ ...data, branches: [branch('loop', 'loop', 'SHOT_PROMPT')] }, 'loop'),
    ).toBeNull();
  });
  function dynamicServer() {
    let activeRun = 'assets';
    let currentNode = 'SHOT_PROMPT';
    const data = {
      ...tree,
      branches: [...tree.branches, branch('other-assets', 'other-script', 'SHOT_PROMPT')],
    };
    api.overview.mockImplementation(async () => ({
      data: {
        run: {
          id: activeRun,
          projectId: 'project',
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          currentNodeId: currentNode,
        },
        nodeStates: [],
      },
    }));
    api.tree.mockImplementation(async () => ({
      data: {
        ...data,
        activeWorkflowRunId: activeRun,
        branches: data.branches.map((b) => ({ ...b, isActive: b.workflowRunId === activeRun })),
      },
    }));
    api.activate.mockImplementation(async (_project: string, run: string, nodeId: string) => {
      activeRun = run;
      currentNode = nodeId;
      return {};
    });
    return { data };
  }
  it('switches A → B → A and restores the exact chosen production descendant after refresh', async () => {
    dynamicServer();
    const state = await mount();
    await call(state, 'activateScriptSelection', 'other-script');
    expect(state.workflowRunId).toBe('other-assets');
    expect(state.activeStep).toBe(2);
    expect(state.storyboardViewedRunId).toBe('other-script');
    await call(state, 'continueScript', 'other-script', 4);
    expect(state.workflowRunId).toBe('other-assets');
    expect(state.activeStep).toBe(4);
    await call(state, 'activateScriptSelection', 'script');
    expect(state.workflowRunId).toBe('assets');
    expect(state.activeStep).toBe(2);
    await call(state, 'selectBranch', { workflowRunId: 'video', nodeId: 'SHOT_RENDER' });
    expect(state.workflowRunId).toBe('video');
    await call(state, 'activateScriptSelection', 'other-script');
    await call(state, 'activateScriptSelection', 'script');
    expect(state.workflowRunId).toBe('video');
    const refreshed = await mount();
    expect(refreshed.workflowRunId).toBe('video');
    expect(refreshed.activeStep).toBe(2);
    expect(api.put).not.toHaveBeenCalled();
  });
  it('serializes activation and prevents superseded replies from reloading an obsolete script', async () => {
    dynamicServer();
    const state = await mount();
    let resolve!: () => void;
    api.activate.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    let latest = true;
    const first = call(state, 'activateScriptSelection', 'other-script', () => latest);
    await settle();
    latest = false;
    const second = call(state, 'activateScriptSelection', 'script', () => true, true);
    resolve();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(state.workflowRunId).toBe('script');
    expect(api.activate.mock.calls.map((args) => args[1])).toEqual(['other-assets', 'script']);
  });
  it('preserves current path on activation failure and uses exact tree script targets', async () => {
    dynamicServer();
    const state = await mount();
    api.activate.mockRejectedValueOnce(new Error('offline'));
    expect(await call(state, 'activateScriptSelection', 'other-script')).toBe(false);
    expect(state.workflowRunId).toBe('assets');
    expect(state.activeStep).toBe(3);
    expect(state.branchError).toContain('切换脚本分支失败');
    await call(state, 'selectBranch', { workflowRunId: 'other-script', nodeId: 'STORYBOARD' });
    expect(state.workflowRunId).toBe('other-script');
    expect(api.activate).toHaveBeenLastCalledWith('project', 'other-script', 'STORYBOARD');
  });
  it('keeps exact script descendants, including multiple production forks, and rejects unrelated or corrupt ancestry', () => {
    expect(customizedProductionNavigationRun(tree, 'assets', 'script')).toBe('assets');
    expect(customizedProductionNavigationRun(tree, 'video', 'script')).toBe('video');
    expect(customizedProductionNavigationRun(tree, 'assets', 'other-script')).toBe('other-script');
    expect(customizedProductionNavigationRun(tree, 'other-script', 'brief')).toBe('brief');
    expect(customizedProductionNavigationRun(null, 'assets', 'script')).toBe('script');
    const broken = { ...tree, branches: [branch('assets', 'assets', 'SHOT_PROMPT')] };
    expect(customizedProductionNavigationRun(broken, 'assets', 'script')).toBe('script');
  });
  it('returns from extraction to assets or video in the current production Run without activating the script ancestor', async () => {
    const state = await mount();
    expect(state.workflowRunId).toBe('assets');
    await call(state, 'selectStep', 1);
    await settle();
    await call(state, 'selectStep', 3);
    await settle();
    expect(state.workflowRunId).toBe('assets');
    expect(state.activeStep).toBe(3);
    expect(api.activate).not.toHaveBeenCalled();
    await call(state, 'selectStep', 1);
    await settle();
    await call(state, 'selectStep', 4);
    await settle();
    expect(state.activeStep).toBe(4);
    expect(api.node).toHaveBeenLastCalledWith('project', 'assets', 'SHOT_RENDER');
    expect(api.put).not.toHaveBeenCalled();
    expect(api.overview).toHaveBeenCalledTimes(1);
  });
  it('keeps the current descendant from both script-page next entries and canvas navigation', async () => {
    const state = await mount();
    await call(state, 'selectStep', 2);
    await settle();
    state.storyboardWorkspace = {
      nextRunId: async () => 'script',
      flushPendingEdits: async () => true,
    };
    await call(state, 'selectStep', 4);
    await settle();
    expect(state.workflowRunId).toBe('assets');
    expect(state.activeStep).toBe(4);
    await call(state, 'continueScript', 'script', 3);
    await settle();
    expect(state.activeStep).toBe(3);
    expect(api.activate).not.toHaveBeenCalled();
  });
  it('activates a different script, and explicit version selection still activates the exact ancestor', async () => {
    const state = await mount();
    api.catalog.mockResolvedValue(catalog('other-script'));
    await call(state, 'selectStep', 1);
    await settle();
    await call(state, 'selectStep', 3);
    await settle();
    expect(api.activate).toHaveBeenCalledWith('project', 'other-script', 'SHOT_PROMPT');
    api.activate.mockClear();
    await call(state, 'selectBranch', { workflowRunId: 'script', nodeId: 'SHOT_PROMPT' });
    expect(api.activate).toHaveBeenCalledWith('project', 'script', 'SHOT_PROMPT');
  });
  it('ignores a late catalog response after the Run changes', async () => {
    const state = await mount();
    await call(state, 'selectStep', 1);
    await settle();
    let resolve!: (value: StoryboardWorkspace) => void;
    api.catalog.mockImplementationOnce(
      () =>
        new Promise<StoryboardWorkspace>((done) => {
          resolve = done;
        }),
    );
    const pending = call(state, 'selectStep', 3);
    await settle();
    state.workflowRunId = 'another-path';
    resolve(catalog());
    await pending;
    expect(api.activate).not.toHaveBeenCalled();
    expect(state.workflowRunId).toBe('another-path');
    expect(state.activeStep).toBe(1);
  });
  it('keeps the current node and Run when pending edits cannot be saved', async () => {
    const state = await mount();
    await call(state, 'selectStep', 1);
    await settle();
    state.extractionWorkspace = { flushPendingEdits: async () => false };
    await call(state, 'selectStep', 3);
    expect(state.activeStep).toBe(1);
    expect(state.workflowRunId).toBe('assets');
    expect(api.catalog).not.toHaveBeenCalled();
    expect(api.activate).not.toHaveBeenCalled();
  });
  it('reloads the same active path and leaves it intact when the catalog fails', async () => {
    const first = await mount();
    await call(first, 'selectStep', 1);
    await settle();
    api.catalog.mockRejectedValueOnce(new Error('目录暂不可用'));
    await call(first, 'selectStep', 3);
    expect(first.activeStep).toBe(1);
    expect(first.workflowRunId).toBe('assets');
    const refreshed = await mount();
    expect(refreshed.workflowRunId).toBe('assets');
    expect(refreshed.activeStep).toBe(3);
    expect(api.activate).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });
});
