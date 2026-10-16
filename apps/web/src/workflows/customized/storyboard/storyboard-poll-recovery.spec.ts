import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import { emptyCustomizedBrief, type StoryboardWorkspace } from '@ai-marketing/contracts';
import Workspace from './CustomizedStoryboardWorkspace.vue';
import { storyboardApi } from './storyboard.api';
import { ApiClientError } from '../../../api/http-client';
import { emptyStoryboardDraft } from './storyboard-state';
vi.mock('./storyboard.api', () => ({
  storyboardApi: { workspace: vi.fn(), settings: vi.fn(), edit: vi.fn() },
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
  parentNode: (c) => c.parent,
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
});
it('silently resumes a transient read failure and removes progress only after a real terminal response', async () => {
  vi.useFakeTimers();
  const initial = {
    sourceRunId: 'root',
    source: null,
    brief: emptyCustomizedBrief(),
    sourceReady: true,
    settings: emptyStoryboardDraft().settings,
    settingsRevision: 1,
    scripts: [],
    selectedScriptId: null,
    legacyDraft: null,
    task: {
      id: 'task',
      workflowRunId: 'root',
      status: 'RUNNING',
      progress: 25,
      steps: [],
      errorMessage: null,
      createdAt: '2026-10-16T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
    },
  } as StoryboardWorkspace;
  vi.mocked(storyboardApi.workspace)
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new ApiClientError('temporarily unavailable', 503))
    .mockResolvedValueOnce({
      ...initial,
      task: { ...initial.task!, status: 'COMPLETED', progress: 100 },
    });
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
    workflowRunId: 'root',
    briefConfirmed: true,
    scopeReadonly: false,
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    await settle();
    expect(state.error).toBe('');
    expect(state.progress).toMatchObject({ value: 25, summary: '正在同步创作状态' });
    expect(storyboardApi.workspace).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(storyboardApi.workspace).toHaveBeenCalledTimes(3);
    expect(state.error).toBe('');
    expect(state.progress).toBeUndefined();
    expect(storyboardApi.settings).not.toHaveBeenCalled();
  } finally {
    app.unmount();
  }
  await vi.advanceTimersByTimeAsync(30000);
  expect(storyboardApi.workspace).toHaveBeenCalledTimes(3);
});
