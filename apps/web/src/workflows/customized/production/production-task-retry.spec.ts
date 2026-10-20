import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';
import type {
  ProductionTask,
  ProductionWorkspace,
  ProductionVideoDocument,
} from '@ai-marketing/contracts';
import Workspace from './CustomizedProductionWorkspace.vue';
import { productionApi } from './production.api';
import { ApiClientError } from '../../../api/http-client';
vi.mock('./production.api', () => ({
  productionApi: {
    workspace: vi.fn(),
    task: vi.fn(),
    retry: vi.fn(),
    start: vi.fn(),
    save: vi.fn(),
  },
}));
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
const cleanups: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
const task = (
  operation: 'PROMPT' | 'RENDER',
  status: ProductionTask['status'] = 'FAILED',
): ProductionTask => ({
  id: 'original',
  operation,
  status,
  progress: 25,
  shotId: null,
  target: { kind: 'CLIP', id: 'clip-a' },
  errorMessage: status === 'FAILED' ? '任务未完成' : null,
  steps: [],
});
const initial = (operation: 'PROMPT' | 'RENDER'): ProductionWorkspace => {
  const document = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).document as ProductionVideoDocument;
  return {
    script: { name: '测试' },
    document,
    confirmedDocument: document,
    prompts: [
      {
        value: { target: { kind: 'CLIP', id: 'clip-a' }, content: '原提示词', assetIds: [] },
        revision: 3,
        stale: false,
      },
    ],
    videos: [{ revision: 1, stale: false, value: { clipId: 'clip-a' } }],
    tasks: [task(operation)],
    draftRevision: 42,
    shotsConfirmed: true,
    assetsConfirmed: true,
  } as unknown as ProductionWorkspace;
};
async function mount(value: ProductionWorkspace) {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(productionApi.workspace).mockResolvedValue(value);
  const props = reactive({ projectId: 'p', workflowRunId: 'r', mode: 'SHOTS' as const });
  let state: Record<string, unknown> = {};
  const component = {
    ...Workspace,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  } as unknown as typeof Workspace;
  const app = renderer.createApp({ render: () => h(component, props) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanups.push(() => app.unmount());
  await settle();
  return {
    state,
    props,
    retry: (id = 'original') => (state.retryTask as (id: string) => Promise<void>)(id),
  };
}
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it.each(['PROMPT', 'RENDER'] as const)(
  'explicitly continues the same %s task, polls real status, preserves artifacts and never creates a new task',
  async (operation) => {
    const value = initial(operation),
      { state, retry } = await mount(value),
      document = structuredClone(value.document);
    expect(productionApi.retry).not.toHaveBeenCalled();
    vi.mocked(productionApi.retry).mockResolvedValue(task(operation, 'QUEUED'));
    vi.mocked(productionApi.task).mockResolvedValue(task(operation, 'RUNNING'));
    await retry();
    expect(productionApi.retry).toHaveBeenCalledWith('p', 'original', expect.any(AbortSignal));
    await retry();
    expect(productionApi.retry).toHaveBeenCalledTimes(1);
    expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('QUEUED');
    expect(state.document).toEqual(document);
    expect((state.workspace as ProductionWorkspace).prompts).toEqual(value.prompts);
    expect((state.workspace as ProductionWorkspace).videos).toEqual(value.videos);
    expect((state.workspace as ProductionWorkspace).draftRevision).toBe(42);
    await vi.advanceTimersByTimeAsync(1801);
    await settle();
    expect(productionApi.task).toHaveBeenCalledWith('p', 'original', expect.any(AbortSignal));
    expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('RUNNING');
    expect(productionApi.start).not.toHaveBeenCalled();
    expect(productionApi.save).not.toHaveBeenCalled();
  },
);
it('preserves the draft and old outputs on a stale-source 409', async () => {
  const value = initial('RENDER'),
    { state, retry } = await mount(value),
    before = structuredClone(value);
  vi.mocked(productionApi.retry).mockRejectedValue(
    new ApiClientError('任务来源已更新，请重新核对', 409),
  );
  await retry();
  expect(state.document).toEqual(before.document);
  expect((state.workspace as ProductionWorkspace).videos).toEqual(before.videos);
  expect((state.workspace as ProductionWorkspace).prompts).toEqual(before.prompts);
  expect((state.retryError as { message: string }).message).toContain('来源已更新');
  expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('FAILED');
  expect(productionApi.save).not.toHaveBeenCalled();
  expect(productionApi.start).not.toHaveBeenCalled();
});
it('does not discard or submit dirty local plan/prompt edits in order to resume an old snapshot', async () => {
  const { state, retry } = await mount(initial('PROMPT'));
  state.videoWorkbench = { hasDirty: true };
  await retry();
  expect(productionApi.retry).not.toHaveBeenCalled();
  state.videoWorkbench = null;
  (state.document as ProductionVideoDocument).videoPlan.shots[0]!.visual = '本地画面修改';
  await settle();
  await retry();
  expect((state.document as ProductionVideoDocument).videoPlan.shots[0]!.visual).toBe(
    '本地画面修改',
  );
  expect(productionApi.retry).not.toHaveBeenCalled();
  expect(productionApi.save).not.toHaveBeenCalled();
  expect((state.retryError as { message: string }).message).toContain('尚未保存');
});
it('deduplicates repeated clicks and ignores a response after the Run changes', async () => {
  const { state, props, retry } = await mount(initial('RENDER'));
  let resolve!: (value: ProductionTask) => void;
  vi.mocked(productionApi.retry).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = retry();
  await retry();
  expect(productionApi.retry).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(productionApi.retry).mock.calls[0]![2]!;
  const next = initial('RENDER');
  next.tasks = [];
  vi.mocked(productionApi.workspace).mockResolvedValue(next);
  props.workflowRunId = 'next-run';
  await settle();
  expect(signal.aborted).toBe(true);
  resolve(task('RENDER', 'QUEUED'));
  await pending;
  expect((state.workspace as ProductionWorkspace).tasks).toHaveLength(0);
  expect(state.retryingTaskId).toBe('');
});
it('reconciles an uncertain POST by reading the same task, never replaying the POST', async () => {
  const { state, retry } = await mount(initial('RENDER'));
  vi.mocked(productionApi.retry).mockRejectedValue(new TypeError('Failed to fetch'));
  vi.mocked(productionApi.task).mockResolvedValue(task('RENDER', 'RUNNING'));
  await retry();
  expect(productionApi.retry).toHaveBeenCalledTimes(1);
  expect(productionApi.task).toHaveBeenCalledWith('p', 'original', expect.any(AbortSignal));
  expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('RUNNING');
  expect(state.retryError).toBeNull();
  expect(productionApi.start).not.toHaveBeenCalled();
});
it('rejects a mismatched callback and a historical failure superseded by a newer attempt', async () => {
  const { state, retry } = await mount(initial('PROMPT'));
  vi.mocked(productionApi.retry).mockResolvedValue({
    ...task('PROMPT', 'QUEUED'),
    target: { kind: 'CLIP', id: 'clip-b' },
  });
  await retry();
  expect((state.workspace as ProductionWorkspace).tasks[0]?.status).toBe('FAILED');
  expect((state.retryError as { message: string }).message).toContain('范围不匹配');
  vi.mocked(productionApi.retry).mockClear();
  (state.workspace as ProductionWorkspace).tasks.unshift({
    ...task('PROMPT', 'COMPLETED'),
    id: 'new',
  });
  await retry();
  expect(productionApi.retry).not.toHaveBeenCalled();
});
it('uses the existing exact-ID retry endpoint without a new generation body', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: task('RENDER', 'QUEUED') })),
    );
  vi.stubGlobal('fetch', fetch);
  const actual = await vi.importActual<{ productionApi: typeof productionApi }>('./production.api');
  await actual.productionApi.retry('fixture', 'task/one');
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/tasks/task%2Fone/retry'),
    expect.objectContaining({ method: 'POST' }),
  );
  expect(fetch.mock.calls[0]![1].body).toBeUndefined();
});
