import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type {
  ProductionTask,
  ProductionWorkspace,
  ProductionVideoDocument,
} from '@ai-marketing/contracts';
import Feedback from './ProductionPromptTaskFeedback.vue';
import Workbench from './ProductionVideoWorkbench.vue';
import Workspace from './CustomizedProductionWorkspace.vue';
import { productionApi } from './production.api';
vi.mock('./production.api', () => ({
  productionApi: {
    workspace: vi.fn(),
    task: vi.fn(),
    promptTask: vi.fn(),
    start: vi.fn(),
    prompt: vi.fn(),
  },
}));
const task = (
  id = 'failed',
  clipId = 'clip-a',
  status: ProductionTask['status'] = 'FAILED',
): ProductionTask => ({
  id,
  operation: 'PROMPT',
  status,
  progress: 60,
  errorMessage: '本次制作未完成，已保存的内容仍然保留',
  shotId: null,
  target: { kind: 'CLIP', id: clipId },
  steps: [{ id: 'REVIEW', status: 'FAILED', title: '独立审校', content: '实际问题' }],
});
const documentFixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).document as ProductionVideoDocument;
const data = (): ProductionWorkspace => {
  const document = documentFixture();
  return {
    script: { name: '测试' },
    document,
    confirmedDocument: document,
    prompts: [],
    tasks: [],
    draftRevision: 1,
    assetsConfirmed: true,
    shotsConfirmed: true,
  } as unknown as ProductionWorkspace;
};
type Host = { children: Host[]; parent: Host | null };
const node = (): Host => ({ children: [], parent: null });
const renderer = createRenderer<Host, Host>({
  createElement: node,
  createText: node,
  createComment: node,
  setText() {},
  setElementText() {},
  patchProp() {},
  insert(c, p) {
    c.parent = p;
    p.children.push(c);
  },
  remove(c) {
    if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
  },
  parentNode: (c) => c.parent,
  nextSibling: () => null,
});
const cleanup: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
function mount(component: object, props: Record<string, unknown>) {
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...component,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    props,
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanup.push(() => app.unmount());
  return state;
}
const call = (state: Record<string, unknown>, name: string, ...args: unknown[]) =>
  (state[name] as (...args: unknown[]) => Promise<unknown>)(...args);
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('per-storyboard prompt failure feedback', () => {
  it.each(['FAILED', 'PARTIAL', 'CANCELLED'] as const)(
    'shows %s with a read-only details action and distinct cancellation semantics',
    async (status) => {
      const current = task('failure', 'clip-a', status);
      const html = await renderToString(createSSRApp(Feedback, { task: current }));
      expect(html).toContain(
        status === 'CANCELLED'
          ? '提示词生成已取消'
          : status === 'PARTIAL'
            ? '提示词生成未完成'
            : '提示词生成失败',
      );
      expect(html).toContain(
        status === 'CANCELLED'
          ? '查看取消记录'
          : status === 'PARTIAL'
            ? '查看未完成详情'
            : '查看失败详情',
      );
      expect(html).toContain('重新生成');
      if (status === 'CANCELLED') {
        expect(html).toContain('information');
        expect(html).not.toContain('本次制作未完成');
        expect(html).not.toContain('danger');
      }
    },
  );
  it.each(['QUEUED', 'RUNNING', 'COMPLETED'] as const)(
    'does not show a terminal warning for %s',
    async (status) => {
      expect(
        await renderToString(createSSRApp(Feedback, { task: task('current', 'clip-a', status) })),
      ).not.toContain('state-alert');
    },
  );
  it('uses the safe error mapper and does not present a non-PROMPT task', async () => {
    const current = { ...task(), errorMessage: 'Traceback: private worker diagnostic' };
    const html = await renderToString(createSSRApp(Feedback, { task: current }));
    expect(html).not.toContain('Traceback');
    expect(html).toContain('本次提示词未完成');
    expect(
      await renderToString(createSSRApp(Feedback, { task: { ...current, operation: 'SHOTS' } })),
    ).not.toContain('state-alert');
  });
  it('keeps old prompt text visible and selects only the current clip latest task', async () => {
    const workspace = data();
    workspace.tasks = [task('other', 'clip-b'), task()];
    workspace.prompts = [
      {
        revision: 1,
        stale: false,
        value: {
          target: { kind: 'CLIP', id: 'clip-a' },
          content: '原提示词仍然保留',
          assetIds: [],
        },
      },
    ];
    const props = {
      projectId: 'p',
      workflowRunId: 'r',
      document: workspace.document as ProductionVideoDocument,
      workspace,
      editing: true,
      locked: false,
      dirty: false,
      savePlan: async () => true,
    };
    let html = await renderToString(createSSRApp(Workbench, props));
    expect(html).toContain('原提示词仍然保留');
    expect(html.match(/提示词生成失败/g)).toHaveLength(1);
    expect(html).toContain('重新生成');
    workspace.tasks = [task('new', 'clip-a', 'COMPLETED'), ...workspace.tasks];
    html = await renderToString(createSSRApp(Workbench, props));
    expect(html).not.toContain('提示词生成失败');
  });
  it('preserves unsaved local typing when a task becomes failed', async () => {
    vi.useFakeTimers();
    const workspace = reactive(data());
    workspace.tasks = [task('current', 'clip-a', 'RUNNING')];
    const state = mount(Workbench, {
      projectId: 'p',
      workflowRunId: 'r',
      document: workspace.document,
      workspace,
      editing: true,
      locked: false,
      dirty: false,
      savePlan: async () => true,
    });
    await settle();
    state.promptText = '本地尚未保存的修改';
    workspace.tasks = [task()];
    await settle();
    expect(state.promptText).toBe('本地尚未保存的修改');
    expect(state.promptIncomplete).toBe(true);
    expect(productionApi.prompt).not.toHaveBeenCalled();
    expect(productionApi.start).not.toHaveBeenCalled();
  });
  it('opens the exact failed task at REVIEW without promoting it ahead of a newer attempt', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const workspace = data();
    workspace.tasks = [task('new', 'clip-a', 'COMPLETED'), task()];
    vi.mocked(productionApi.workspace).mockResolvedValue(workspace);
    vi.mocked(productionApi.task).mockResolvedValue(task());
    const state = mount(Workspace, { projectId: 'p', workflowRunId: 'r', mode: 'SHOTS' });
    await settle();
    await call(state, 'openPromptWorkflow', 'clip-a', 'failed');
    expect(productionApi.task).toHaveBeenCalledWith('p', 'failed', expect.any(AbortSignal));
    expect(productionApi.promptTask).not.toHaveBeenCalled();
    expect(state.graphTaskId).toBe('failed');
    expect(state.graphNode).toBe('REVIEW');
    expect((state.workspace as ProductionWorkspace).tasks[0]!.id).toBe('new');
    expect(productionApi.start).not.toHaveBeenCalled();
  });
  it('rejects mismatched details and ignores late reads after selecting another task', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.mocked(productionApi.workspace).mockResolvedValue(data());
    const state = mount(Workspace, { projectId: 'p', workflowRunId: 'r', mode: 'SHOTS' });
    await settle();
    vi.mocked(productionApi.task).mockResolvedValueOnce(task('failed', 'clip-b'));
    await call(state, 'openPromptWorkflow', 'clip-a', 'failed');
    expect(state.graphError).toContain('不属于当前分镜');
    expect((state.workspace as ProductionWorkspace).tasks).toHaveLength(0);
    let resolve!: (value: ProductionTask) => void;
    vi.mocked(productionApi.task).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const earlier = call(state, 'openPromptWorkflow', 'clip-a', 'failed');
    await settle();
    vi.mocked(productionApi.task).mockResolvedValueOnce(task('second', 'clip-b'));
    await call(state, 'openPromptWorkflow', 'clip-b', 'second');
    resolve(task());
    await earlier;
    expect(state.graphTaskId).toBe('second');
    expect(state.graphClipId).toBe('clip-b');
  });
});
