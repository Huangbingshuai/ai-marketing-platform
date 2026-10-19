import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import type { CustomizedExtractionWorkspace, CustomizedBrief } from '@ai-marketing/contracts';
import { ApiClientError } from '../../../api/http-client';
import Workspace from './CustomizedExtractionWorkspace.vue';
import { extractionApi } from './customized-extraction.api';

vi.mock('./customized-extraction.api', () => ({ extractionApi: { workspace: vi.fn() } }));
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
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('keeps a failed workspace load visible in Chinese, preserves local fields, and retries with the same Run', async () => {
  vi.stubGlobal('sessionStorage', { getItem: () => null });
  const failure = new ApiClientError('property workflowRunId should not exist', 400);
  const data: CustomizedExtractionWorkspace = {
    projectId: 'project',
    workflowRunId: 'run',
    source: null,
    task: null,
    result: null,
    brandReferences: [],
    sourceWarnings: [],
    committed: false,
    stale: false,
    editing: false,
    temporary: false,
  };
  vi.mocked(extractionApi.workspace)
    .mockRejectedValueOnce(failure)
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce({ success: true, data });
  let state: Record<string, unknown> = {};
  const app = renderer.createApp(
    {
      ...Workspace,
      render(this: { $: { setupState: Record<string, unknown> } }) {
        state = this.$.setupState;
        return h('div');
      },
    },
    { projectId: 'project', workflowRunId: 'run', sourceConfirmed: true, sources: [] },
  );
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  try {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
      await nextTick();
    }
    expect(state.loading).toBe(false);
    expect(state.loadError).toBe('系统暂时无法处理当前请求，请重新加载后重试。');
    const view = state.view as { fields: CustomizedBrief };
    view.fields.brandName = '本地未保存品牌';
    await (state.load as () => Promise<void>)();
    expect(view.fields.brandName).toBe('本地未保存品牌');
    expect(state.loadError).not.toBe('');
    await (state.load as () => Promise<void>)();
    expect(state.loadError).toBe('');
    expect(state.workspace).toEqual(data);
    expect(extractionApi.workspace).toHaveBeenCalledTimes(3);
    for (const args of vi.mocked(extractionApi.workspace).mock.calls)
      expect(args).toEqual(['project', 'run', expect.any(AbortSignal)]);
  } finally {
    app.unmount();
  }
});
