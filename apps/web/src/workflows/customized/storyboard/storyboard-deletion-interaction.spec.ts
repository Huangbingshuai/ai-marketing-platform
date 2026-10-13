import { beforeEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import { emptyCustomizedBrief, type StoryboardWorkspace } from '@ai-marketing/contracts';
import Workspace from './CustomizedStoryboardWorkspace.vue';
import { storyboardApi } from './storyboard.api';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import { ApiClientError } from '../../../api/http-client';
import { createStoryboardScript, emptyStoryboardDraft } from './storyboard-state';

const captured = vi.hoisted(() => ({ page: {} as Record<string, unknown>, remove: () => {} }));
vi.mock('./storyboard.api', () => ({
  storyboardApi: { workspace: vi.fn(), settings: vi.fn(), edit: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../../shared/composables/action-confirmation', () => ({
  requestActionConfirmation: vi.fn(),
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
  insert(child, parent, anchor) {
    child.parent = parent;
    const i = anchor ? parent.children.indexOf(anchor) : -1;
    if (i < 0) parent.children.push(child);
    else parent.children.splice(i, 0, child);
  },
  remove(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  },
  parentNode: (child) => child.parent,
  nextSibling: () => null,
});
const settle = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
function fixture(editing = false): StoryboardWorkspace {
  const source = { artifactId: 'brief', revision: 1, fingerprint: 'hash' };
  return {
    sourceRunId: 'root',
    source,
    brief: emptyCustomizedBrief(),
    sourceReady: true,
    settings: emptyStoryboardDraft().settings,
    settingsRevision: 1,
    selectedScriptId: 'a',
    task: null,
    legacyDraft: null,
    scripts: ['a', 'b'].map((id) => ({
      id,
      workflowRunId: `run-${id}`,
      source,
      status: 'COMPLETED',
      origin: 'MANUAL',
      revision: 4,
      editing: editing && id === 'a',
      stale: false,
      script: { ...createStoryboardScript(id), id },
      confirmedRevision: 1,
      taskId: null,
    })),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestActionConfirmation).mockResolvedValue(true);
});
async function mount(value: StoryboardWorkspace) {
  vi.mocked(storyboardApi.workspace).mockImplementation(async () => structuredClone(value));
  const deleted = vi.fn();
  // Vitest compiles Vue in SSR mode. Supply only a tiny host view; exercise the real workspace
  // setup, watchers and request queue without requiring a browser DOM or copying action logic.
  const component = Object.assign({}, Workspace, {
    render(this: { $: { setupState: Record<string, unknown> } }) {
      const state = this.$.setupState;
      state.page = { guardEditor: async () => true };
      captured.page = { draft: state.draft, error: state.error, deleting: !!state.deletingId };
      captured.remove = state.remove as () => void;
      return h('div');
    },
  });
  const app = renderer.createApp(component, {
    projectId: 'project',
    workflowRunId: 'root',
    briefConfirmed: true,
    scopeReadonly: false,
    onDeleted: deleted,
  });
  app.provide(ssrContextKey, { modules: new Set() });
  const vm = app.mount(node()) as unknown as { flushPendingEdits(): Promise<boolean> };
  await settle();
  return { app, vm, deleted };
}
it('canceling confirmation never calls deletion or changes the selected script', async () => {
  const { app, deleted } = await mount(fixture());
  try {
    vi.mocked(requestActionConfirmation).mockResolvedValue(false);
    captured.remove();
    await settle();
    expect(storyboardApi.remove).not.toHaveBeenCalled();
    expect(captured.page.draft).toMatchObject({
      activeScriptId: 'a',
      scripts: [{ id: 'a' }, { id: 'b' }],
    });
    expect(deleted).not.toHaveBeenCalled();
  } finally {
    app.unmount();
  }
});
it('a conflict keeps the script and local edits visible and re-enables deletion', async () => {
  const { app } = await mount(fixture(true));
  try {
    const draft = captured.page.draft as ReturnType<typeof emptyStoryboardDraft>;
    draft.scripts[0]!.name = '保留本地修改';
    vi.mocked(storyboardApi.remove).mockRejectedValue(new ApiClientError('revision conflict', 409));
    captured.remove();
    await settle();
    expect(draft.scripts[0]!.name).toBe('保留本地修改');
    expect(draft.scripts).toHaveLength(2);
    expect(captured.page.deleting).toBe(false);
    expect(captured.page.error).toContain('本地修改仍保留');
  } finally {
    app.unmount();
  }
});
it('waits for an in-flight save, uses its revision and cannot restore a deleted script from a late read', async () => {
  const value = fixture(true);
  const { app, vm, deleted } = await mount(value);
  try {
    const draft = captured.page.draft as ReturnType<typeof emptyStoryboardDraft>;
    draft.scripts[0]!.name = '已发出的修改';
    let finish!: (v: { revision: number }) => void;
    vi.mocked(storyboardApi.edit).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const save = vm.flushPendingEdits();
    await settle();
    captured.remove();
    await settle();
    expect(storyboardApi.remove).not.toHaveBeenCalled();
    vi.mocked(storyboardApi.remove).mockResolvedValue({
      scriptId: 'a',
      removedScriptIds: ['a'],
      removedRunIds: ['run-a', 'child'],
      fallbackRunId: 'root',
      activeRunChanged: false,
    });
    finish({ revision: 5 });
    await save;
    await settle();
    expect(storyboardApi.remove).toHaveBeenCalledWith(
      'project',
      'a',
      'root',
      5,
      expect.any(AbortSignal),
    );
    expect(captured.page.draft).toMatchObject({ activeScriptId: 'b', scripts: [{ id: 'b' }] });
    expect(deleted).toHaveBeenCalledOnce();
    expect(captured.page.deleting).toBe(false);
  } finally {
    app.unmount();
  }
});
it('reports committed deletion even when the following directory read fails', async () => {
  const { app, deleted } = await mount(fixture());
  try {
    vi.mocked(storyboardApi.remove).mockResolvedValue({
      scriptId: 'a',
      removedScriptIds: ['a'],
      removedRunIds: ['run-a'],
      fallbackRunId: 'root',
      activeRunChanged: false,
    });
    vi.mocked(storyboardApi.workspace).mockRejectedValue(new Error('offline'));
    captured.remove();
    await settle();
    expect(captured.page.draft).toMatchObject({ activeScriptId: 'b', scripts: [{ id: 'b' }] });
    expect(captured.page.error).toContain('已删除');
    expect(deleted).toHaveBeenCalledOnce();
  } finally {
    app.unmount();
  }
});
