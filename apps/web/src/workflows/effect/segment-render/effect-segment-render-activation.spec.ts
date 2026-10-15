import type { EffectImportProduct } from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS } from '@ai-marketing/contracts';
import { createRenderer, defineComponent, h, KeepAlive, nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './EffectSegmentRenderNodePage.vue';

const mocks = vi.hoisted(() => ({ load: vi.fn(), artifacts: vi.fn() }));
vi.mock('./services/effect-segment-render-workspace.service', () => ({
  loadEffectSegmentRenderWorkspaceSnapshot: mocks.load,
}));
vi.mock('../../../platform/workflow/api/workflow-working.api', () => ({
  listWorkingArtifacts: mocks.artifacts,
  beginEffectWorkflowNodeEdit: vi.fn(),
  cancelEffectWorkflowNodeEdit: vi.fn(),
}));

// Run the real page's setup/watchers/lifecycle without a DOM or media downloads.
const SetupOnlyPage = Object.assign({}, Page, { render: () => null });
const renderer = createRenderer({
  patchProp: () => {}, insert: () => {}, remove: () => {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  setText: () => {}, setElementText: () => {}, parentNode: () => null, nextSibling: () => null,
});
const product = (id: string): EffectImportProduct =>
  ({ id, name: '广式腊肠', status: 'ACTIVE' }) as EffectImportProduct;
const mountedApps: { unmount(): void }[] = [];
const settle = async () => { await nextTick(); await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mocks.artifacts.mockResolvedValue({ data: { items: [] } });
  mocks.load.mockImplementation(async (scope) => ({
    prefetched: false,
    data: { ...scope, batch: null, promptReady: true, promptCount: 33,
      promptArtifactRevision: 11, settingsRevision: 1,
      settings: { ...DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS } },
  }));
});
afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetAllMocks();
});

describe('render page KeepAlive branch activation', () => {
  it.each(['新增模板', '智能填充', '包装'])('%s 后返回渲染读取新 Run 的商品且只加载一次', async () => {
    const scope = reactive({ visible: true, workflowRunId: 'parent-run', products: [product('parent-product')] });
    const app = renderer.createApp(defineComponent({ setup: () => () => h(KeepAlive, null, {
      default: () => scope.visible ? h(SetupOnlyPage, {
        key: 'render:project', projectId: 'project', workflowRunId: scope.workflowRunId,
        products: scope.products,
      }) : null,
    }) }));
    app.provide(Symbol.for('v-scx'), {});
    mountedApps.push(app); app.mount({}); await settle();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load.mock.calls[0]?.[0].productId).toBe('parent-product');
    scope.visible = false; await settle();
    scope.workflowRunId = 'intermediate-run'; scope.products = [product('intermediate-product')];
    await settle();
    scope.workflowRunId = 'child-run'; scope.products = [product('child-product')];
    await settle();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    scope.visible = true; await settle();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.load.mock.calls[1]?.[0]).toEqual({
      projectId: 'project', workflowRunId: 'child-run', productId: 'child-product',
    });
    scope.visible = false; await settle(); scope.visible = true; await settle();
    expect(mocks.load).toHaveBeenCalledTimes(3);
    expect(mocks.load.mock.calls[2]?.[0].productId).toBe('child-product');
  });
});
