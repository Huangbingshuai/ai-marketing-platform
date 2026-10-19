import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue';
import {
  CUSTOMIZED_IMAGE_MODELS,
  type Asset,
  type ProductionAsset,
  type CustomizedImageSettings,
} from '@ai-marketing/contracts';
import Composer from './ProductionImageComposer.vue';
import { productionApi } from './production.api';
import { defaultAssetImagePrompt } from './production-image-input';

vi.mock('./production.api', () => ({ productionApi: { uploadImageReference: vi.fn() } }));
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
const asset = (): ProductionAsset => ({
  id: 'object',
  kind: 'PRODUCT',
  name: '随行杯',
  description: '公共定义',
  knownFacts: '',
  designNotes: '',
  sourceText: '',
});
const settle = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
const call = (state: Record<string, unknown>, key: string, ...args: unknown[]) =>
  (state[key] as (...args: unknown[]) => unknown)(...args);
type LiveProps = {
  asset: ProductionAsset;
  projectId: string;
  workflowRunId: string;
  settings: CustomizedImageSettings | undefined;
  busy: boolean;
};
function mount() {
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const props = reactive<LiveProps>({
    asset: asset(),
    projectId: 'p',
    workflowRunId: 'r',
    settings: undefined,
    busy: false,
  });
  const generate = vi.fn();
  let state: Record<string, unknown> = {};
  const child = {
    ...Composer,
    render(this: { $: { setupState: Record<string, unknown> } }) {
      state = this.$.setupState;
      return h('div');
    },
  } as unknown as typeof Composer;
  const app = renderer.createApp({ render: () => h(child, { ...props, onGenerate: generate }) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(node());
  cleanup.push(() => app.unmount());
  return { props, state, generate };
}
const fileEvent = (count = 1) => ({
  target: {
    files: Array.from(
      { length: count },
      (_, i) => new File(['png'], `brand${i}.png`, { type: 'image/png' }),
    ),
    value: '',
  },
});
function deferred() {
  let resolve!: (value: Asset) => void, reject!: (error: Error) => void;
  const promise = new Promise<Asset>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const uploaded = (id = '92c0e655-63cc-46f3-a788-3af2bcfc8295') =>
  ({ id, name: '品牌PNG', currentVersion: 1 }) as Asset;
const selected = {
  assetId: '9b3d3cc9-31b6-445b-94ab-30f49414a80d',
  version: 1,
  name: '已选品牌图',
};
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('image composer input lifecycle', () => {
  it('keeps an in-flight multi-file upload and manual parameters across equal asset/preset rematerialization', async () => {
    const { props, state, generate } = mount(),
      first = deferred(),
      second = deferred();
    vi.mocked(productionApi.uploadImageReference)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    state.text = '本次人工提示词';
    state.model = CUSTOMIZED_IMAGE_MODELS[1].id;
    state.resolution = '1K';
    state.ratio = '4:3';
    call(state, 'chooseBrand', selected);
    const upload = call(state, 'upload', fileEvent(2));
    await settle();
    const signal = vi.mocked(productionApi.uploadImageReference).mock.calls[0]![3]!;
    call(state, 'submit');
    expect(generate).not.toHaveBeenCalled();
    props.asset = {
      ...asset(),
      image: { assetId: 'preview-only', version: 2 },
      manualFields: ['description'],
    };
    props.settings = {
      model: CUSTOMIZED_IMAGE_MODELS[0].id,
      resolution: '2K',
      ratio: 'auto',
      assetIds: ['object'],
      inputs: [{ assetId: 'object', prompt: defaultAssetImagePrompt(asset()), references: [] }],
    };
    await settle();
    expect(signal.aborted).toBe(false);
    expect(state.uploading).toBe(true);
    expect(state.references).toHaveLength(1);
    expect(state.text).toBe('本次人工提示词');
    expect(state.model).toBe(CUSTOMIZED_IMAGE_MODELS[1].id);
    expect(state.resolution).toBe('1K');
    expect(state.ratio).toBe('4:3');
    expect(state.basisChanged).toBe(false);
    first.resolve(uploaded());
    await settle();
    expect(productionApi.uploadImageReference).toHaveBeenCalledTimes(2);
    expect(vi.mocked(productionApi.uploadImageReference).mock.calls[1]!.slice(0, 2)).toEqual([
      'p',
      'r',
    ]);
    second.resolve(uploaded('7ae4494c-ef48-451b-8f0e-3fcba6361594'));
    await upload;
    props.asset = structuredClone(asset());
    props.settings = JSON.parse(JSON.stringify(props.settings));
    await settle();
    expect(state.references).toHaveLength(3);
    expect(state.valid).toBe(true);
    call(state, 'submit');
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: CUSTOMIZED_IMAGE_MODELS[1].id,
        resolution: '1K',
        ratio: '4:3',
        inputs: [
          expect.objectContaining({
            prompt: '本次人工提示词',
            references: [
              { assetId: selected.assetId, version: 1 },
              { assetId: uploaded().id, version: 1 },
              { assetId: '7ae4494c-ef48-451b-8f0e-3fcba6361594', version: 1 },
            ],
          }),
        ],
      }),
    );
  });
  it.each(['projectId', 'workflowRunId', 'asset'] as const)(
    'isolates a true %s switch and ignores late upload success or remaining files',
    async (key) => {
      const { props, state } = mount(),
        pending = deferred();
      vi.mocked(productionApi.uploadImageReference).mockReturnValueOnce(pending.promise);
      call(state, 'chooseBrand', selected);
      const upload = call(state, 'upload', fileEvent(2));
      await settle();
      const signal = vi.mocked(productionApi.uploadImageReference).mock.calls[0]![3]!;
      if (key === 'asset') props.asset = { ...asset(), id: 'other-object' };
      else props[key] = 'other';
      await settle();
      expect(signal.aborted).toBe(true);
      expect(state.uploading).toBe(false);
      expect(state.references).toHaveLength(0);
      expect(state.scopeNotice).toContain('已切换');
      pending.resolve(uploaded());
      await upload;
      expect(state.references).toHaveLength(0);
      expect(productionApi.uploadImageReference).toHaveBeenCalledTimes(1);
    },
  );
  it('retains local inputs on a real definition change, blocks generation and requires explicit review', async () => {
    const { props, state, generate } = mount(),
      pending = deferred();
    vi.mocked(productionApi.uploadImageReference).mockReturnValueOnce(pending.promise);
    state.text = '人工输入';
    call(state, 'chooseBrand', selected);
    const upload = call(state, 'upload', fileEvent());
    await settle();
    const signal = vi.mocked(productionApi.uploadImageReference).mock.calls[0]![3]!;
    props.asset = { ...asset(), description: '新公共定义' };
    await settle();
    expect(signal.aborted).toBe(true);
    expect(state.text).toBe('人工输入');
    expect(state.references).toHaveLength(1);
    expect(state.basisChanged).toBe(true);
    expect(state.valid).toBe(false);
    expect(state.scopeNotice).toContain('未完成上传已停止');
    call(state, 'submit');
    expect(generate).not.toHaveBeenCalled();
    props.busy = true;
    await settle();
    call(state, 'reviewBasis', false);
    expect(state.basisChanged).toBe(true);
    props.busy = false;
    await settle();
    call(state, 'reviewBasis', false);
    expect(state.valid).toBe(true);
    expect(state.text).toBe('人工输入');
    pending.resolve(uploaded());
    await upload;
    expect(state.references).toHaveLength(1);
    call(state, 'submit');
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [
          expect.objectContaining({
            prompt: '人工输入',
            references: [{ assetId: selected.assetId, version: 1 }],
          }),
        ],
      }),
    );
  });
  it('only loads new saved settings after explicit review and ignores property insertion order', async () => {
    const { props, state } = mount();
    state.text = '本地输入';
    call(state, 'chooseBrand', selected);
    props.settings = {
      model: CUSTOMIZED_IMAGE_MODELS[1].id,
      resolution: '1K',
      ratio: '4:3',
      assetIds: ['object'],
      inputs: [{ assetId: 'object', prompt: '新保存设置', references: [] }],
    };
    await settle();
    expect(state.text).toBe('本地输入');
    expect(state.references).toHaveLength(1);
    expect(state.valid).toBe(false);
    call(state, 'reviewBasis', true);
    expect(state.text).toBe('新保存设置');
    expect(state.references).toHaveLength(0);
    expect(state.valid).toBe(true);
    state.text = '重新编辑';
    props.asset = {
      sourceText: '',
      designNotes: '',
      knownFacts: '',
      description: '公共定义',
      name: '随行杯',
      kind: 'PRODUCT',
      id: 'object',
    };
    props.settings = {
      ratio: '4:3',
      inputs: [{ references: [], prompt: '新保存设置', assetId: 'object' }],
      assetIds: ['object'],
      resolution: '1K',
      model: CUSTOMIZED_IMAGE_MODELS[1].id,
    };
    await settle();
    expect(state.text).toBe('重新编辑');
    expect(state.basisChanged).toBe(false);
  });
  it('keeps old-scope failures from replacing current status, and aborts on unmount', async () => {
    const { props, state } = mount(),
      old = deferred(),
      current = deferred();
    vi.mocked(productionApi.uploadImageReference)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const upload = call(state, 'upload', fileEvent());
    await settle();
    props.workflowRunId = 'other';
    await settle();
    const next = call(state, 'upload', fileEvent());
    await settle();
    old.reject(new Error('旧上传失败'));
    await upload;
    expect(state.uploading).toBe(true);
    expect(state.uploadError).toBe('');
    const signal = vi.mocked(productionApi.uploadImageReference).mock.calls[1]![3]!;
    cleanup.shift()!();
    expect(signal.aborted).toBe(true);
    current.resolve(uploaded());
    await next;
    expect(state.references).toHaveLength(0);
  });
  it('prevents upload, reference changes and generation while the parent is submitting', async () => {
    const { props, state, generate } = mount();
    props.busy = true;
    await settle();
    call(state, 'chooseBrand', selected);
    await call(state, 'upload', fileEvent());
    call(state, 'toggle', 'models');
    call(state, 'submit');
    expect(state.references).toHaveLength(0);
    expect(state.panel).toBe('');
    expect(state.valid).toBe(false);
    expect(productionApi.uploadImageReference).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
