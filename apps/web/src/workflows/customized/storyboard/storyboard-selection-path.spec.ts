import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import { emptyCustomizedBrief, type StoryboardWorkspace } from '@ai-marketing/contracts';
import Workspace from './CustomizedStoryboardWorkspace.vue';
import { storyboardApi } from './storyboard.api';
import { createStoryboardScript, emptyStoryboardDraft } from './storyboard-state';

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
  parentNode: (child) => child.parent,
  nextSibling: () => null,
});
const settle = async () => {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.resetAllMocks();
});
async function mount(activate = vi.fn().mockResolvedValue(true)) {
  const a = { ...createStoryboardScript('甲'), id: 'a' };
  const b = { ...createStoryboardScript('乙'), id: 'b' };
  const data: StoryboardWorkspace = {
    sourceRunId: 'brief',
    source: null,
    brief: emptyCustomizedBrief(),
    sourceReady: true,
    settings: emptyStoryboardDraft().settings,
    settingsRevision: 1,
    selectedScriptId: 'a',
    task: null,
    legacyDraft: null,
    scripts: [a, b].map((script) => ({
      id: script.id,
      workflowRunId: 'run-' + script.id,
      source: { artifactId: 'brief-artifact', revision: 1, fingerprint: 'brief-fingerprint' },
      status: 'COMPLETED',
      origin: 'AI',
      revision: 1,
      confirmedRevision: 1,
      editing: false,
      stale: false,
      taskId: null,
      script,
    })),
  };
  vi.mocked(storyboardApi.workspace).mockImplementation(async () => structuredClone(data));
  vi.mocked(storyboardApi.settings).mockImplementation(async (_p, _r, _v, settings, selected) => {
    data.settings = structuredClone(settings);
    data.selectedScriptId = selected;
    return { revision: ++data.settingsRevision };
  });
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...Workspace,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    {
      projectId: 'project',
      workflowRunId: 'run-a',
      briefConfirmed: true,
      scopeReadonly: false,
      activateScript: activate,
    },
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanup.push(() => app.unmount());
  await settle();
  state.page = { guardEditor: async () => true };
  activate.mockClear();
  return {
    state,
    data,
    activate,
    select: (id: string) => (state.select as (id: string) => Promise<boolean>)(id),
  };
}
it('saves the selected script before activating its path and does not edit business content', async () => {
  const { data, activate, select } = await mount();
  activate.mockImplementation(async (run: string) => {
    expect(data.selectedScriptId).toBe('b');
    expect(run).toBe('run-b');
    return true;
  });
  expect(await select('b')).toBe(true);
  expect(activate).toHaveBeenCalledTimes(1);
  expect(storyboardApi.edit).not.toHaveBeenCalled();
  expect(data.scripts.map((s) => s.confirmedRevision)).toEqual([1, 1]);
});
it('restores the previous selection when path activation fails', async () => {
  const { data, activate, select, state } = await mount();
  activate.mockResolvedValue(false);
  expect(await select('b')).toBe(false);
  expect((state.draft as { activeScriptId: string }).activeScriptId).toBe('a');
  expect(data.selectedScriptId).toBe('a');
  expect(state.error).toContain('分支切换未完成');
});
it('does not activate a script when its selection cannot be saved', async () => {
  const { data, activate, select, state } = await mount();
  vi.mocked(storyboardApi.settings).mockRejectedValueOnce(new Error('network unavailable'));
  expect(await select('b')).toBe(false);
  expect(activate).not.toHaveBeenCalled();
  expect(data.selectedScriptId).toBe('a');
  expect((state.draft as { activeScriptId: string }).activeScriptId).toBe('a');
});
it('marks an earlier activation stale when a newer script is clicked', async () => {
  const { data, activate, select, state } = await mount();
  let finish!: (value: boolean) => void;
  let firstCurrent!: () => boolean;
  activate.mockImplementationOnce((_run: string, current: () => boolean) => {
    firstCurrent = current;
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  });
  const first = select('b');
  await settle();
  expect(firstCurrent()).toBe(true);
  const second = select('a');
  await settle();
  expect(firstCurrent()).toBe(false);
  finish(false);
  await Promise.all([first, second]);
  expect(data.selectedScriptId).toBe('a');
  expect((state.draft as { activeScriptId: string }).activeScriptId).toBe('a');
  expect(state.error).toBe('');
});
