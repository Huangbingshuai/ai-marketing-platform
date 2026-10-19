import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey } from 'vue';
import {
  CUSTOMIZED_IMAGE_MODELS,
  type ProductionAsset,
  type ProductionWorkspace,
  type CustomizedImageSettings,
} from '@ai-marketing/contracts';
import Dialog from './ProductionRenderDialog.vue';
import Studio from './ProductionAssetStudio.vue';
import Library from './ProductionReferenceLibrary.vue';
import Preparation from './ProductionAssetPreparation.vue';
import Workspace from './CustomizedProductionWorkspace.vue';
import {
  imageSource,
  independentlyPrepared,
  referenceImageSources,
} from './production-asset-images';
import { productionApi } from './production.api';

vi.mock('./production.api', () => ({
  productionApi: { workspace: vi.fn(), save: vi.fn(), start: vi.fn() },
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
const unmount: (() => void)[] = [];
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
  unmount.push(() => app.unmount());
  return state;
}
const settle = async () => {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await nextTick();
  }
};
const call = (state: Record<string, unknown>, key: string, ...args: unknown[]) =>
  (state[key] as (...args: unknown[]) => unknown)(...args);
function asset(
  id: string,
  kind: ProductionAsset['kind'] = 'SCENE',
  parentId: string | null = null,
): ProductionAsset {
  return {
    id,
    kind,
    name: id,
    description: `${id}公共形象`,
    knownFacts: '',
    designNotes: '',
    sourceText: '',
    preparation: {
      treatment: parentId ? 'SCENE_DETAIL' : 'INDEPENDENT',
      parentId,
      aliases: [],
      usage: '',
      sources: [],
      details: [],
      questions: [],
      images: [],
    },
  };
}
const catalog = () => [
  ...Array.from({ length: 10 }, (_, i) => asset(`s${i}`)),
  ...Array.from({ length: 4 }, (_, i) => asset(`d${i}`, 'PROP', `s${i}`)),
];
afterEach(() => {
  unmount.splice(0).forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('asset image ownership interactions', () => {
  it('selects only the 10 independent objects and refuses an injected attached selection', () => {
    const assets = catalog(),
      generate = vi.fn();
    const state = mount(Dialog, { open: true, type: 'IMAGE', assets, onGenerate: generate });
    expect(state.selectedIds).toEqual(assets.slice(0, 10).map((a) => a.id));
    expect(state.valid).toBe(true);
    state.selectedIds = ['s0', 'd0'];
    call(state, 'submit');
    expect(generate).not.toHaveBeenCalled();
    state.selectedIds = ['s0'];
    call(state, 'submit');
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ assetIds: ['s0'] }));
  });
  it('rejects unknown, duplicate and empty selections', () => {
    const generate = vi.fn();
    const state = mount(Dialog, {
      open: true,
      type: 'IMAGE',
      assets: catalog(),
      onGenerate: generate,
    });
    for (const ids of [[], ['s0', 's0'], ['unknown']]) {
      state.selectedIds = ids;
      call(state, 'submit');
      expect(state.valid).toBe(false);
    }
    expect(generate).not.toHaveBeenCalled();
  });
  it('rechecks ownership after the catalog changes while the dialog stays open', async () => {
    const assets = catalog(),
      generate = vi.fn();
    const { reactive } = await import('vue');
    const live = reactive(assets);
    const state = mount(Dialog, { open: true, type: 'IMAGE', assets: live, onGenerate: generate });
    live[0]!.preparation = { ...live[0]!.preparation!, treatment: 'SCENE_DETAIL', parentId: 's1' };
    await nextTick();
    call(state, 'submit');
    expect(state.valid).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
  it('opens the parent definition rather than generating an attached object', () => {
    const assets = catalog(),
      images = vi.fn();
    const state = mount(Studio, {
      projectId: 'p',
      assets,
      shots: [],
      editing: false,
      locked: false,
      onImages: images,
    });
    call(state, 'render', [assets[10]!]);
    expect(state.detailId).toBe('s0');
    expect(images).not.toHaveBeenCalled();
    call(state, 'render', assets);
    expect(images).toHaveBeenCalledWith(assets.slice(0, 10));
    state.filter = 'MISSING';
    expect(state.filtered).toHaveLength(10);
  });
  it('uses exact parent images, deduplicates right-panel references and blocks invalid ancestry', () => {
    const parent = { ...asset('scene'), image: { assetId: 'image', version: 2 } };
    const detail = {
      ...asset('table', 'PROP', 'scene'),
      image: { assetId: 'old-child', version: 1 },
    };
    const legacy: ProductionAsset = {
      id: 'legacy',
      kind: 'PROP',
      name: '旧道具',
      description: '旧图',
      knownFacts: '',
      designNotes: '',
      sourceText: '',
    };
    const assets = [parent, detail, legacy];
    expect(imageSource(assets, detail)).toBe(parent);
    expect(referenceImageSources(assets, [detail, parent])).toEqual([parent]);
    expect(independentlyPrepared(assets, legacy)).toBe(true);
    const invalid = { ...detail, preparation: { ...detail.preparation!, parentId: 'missing' } };
    expect(imageSource([parent, invalid], invalid)).toBeNull();
    expect(referenceImageSources([invalid], [invalid])[0]?.image).toBeNull();
    const cycle = {
      ...parent,
      preparation: {
        ...parent.preparation!,
        treatment: 'SCENE_DETAIL' as const,
        parentId: 'scene',
      },
    };
    expect(imageSource([cycle], cycle)).toBeNull();
  });
  it('previews and navigates to the parent without changing the child shot binding', () => {
    const parent = { ...asset('scene'), image: { assetId: 'image', version: 1 } },
      child = asset('table', 'PROP', 'scene');
    const preview = vi.fn(),
      prepare = vi.fn();
    const shot = { bindings: [{ assetId: child.id, description: '' }] };
    const state = mount(Library, {
      projectId: 'p',
      assets: [parent, child],
      shot,
      locked: false,
      onPreview: preview,
      onPrepare: prepare,
    });
    call(state, 'preview', child);
    expect(preview).toHaveBeenCalledWith(parent);
    call(state, 'prepare', child);
    expect(prepare).toHaveBeenCalledWith(parent);
    expect(shot.bindings[0]!.assetId).toBe(child.id);
  });
  it('changes ownership only by explicit editing and excludes cycles', () => {
    const child = asset('table', 'PROP', 'scene'),
      scene = asset('scene'),
      update = vi.fn();
    const state = mount(Preparation, {
      asset: child,
      assets: [scene, child],
      readonly: false,
      onUpdate: update,
    });
    call(state, 'treatment', { target: { value: 'INDEPENDENT' } });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ treatment: 'INDEPENDENT', parentId: null }),
    );
    expect(child.preparation?.treatment).toBe('SCENE_DETAIL');
    expect(call(state, 'parents', 'SCENE_DETAIL')).toEqual([scene]);
    const readonly = mount(Preparation, {
      asset: child,
      assets: [scene, child],
      readonly: true,
      onUpdate: update,
    });
    update.mockClear();
    call(readonly, 'treatment', { target: { value: 'INDEPENDENT' } });
    expect(update).not.toHaveBeenCalled();
  });
  it('blocks paid IMAGE creation before saving an invalid attached selection', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const assets = catalog();
    const document = { assets, shots: [] };
    vi.mocked(productionApi.workspace).mockResolvedValue({
      script: { name: '测试' },
      document,
      confirmedDocument: document,
      prompts: [],
      tasks: [],
      draftRevision: 1,
      assetsConfirmed: true,
    } as unknown as ProductionWorkspace);
    const state = mount(Workspace, { projectId: 'p', workflowRunId: 'r', mode: 'ASSETS' });
    await settle();
    const settings: CustomizedImageSettings = {
      model: CUSTOMIZED_IMAGE_MODELS[0].id,
      resolution: '2K',
      ratio: '1:1',
      assetIds: ['d0'],
      inputs: [],
    };
    await call(state, 'generateImages', settings);
    expect(productionApi.start).not.toHaveBeenCalled();
    expect(productionApi.save).not.toHaveBeenCalled();
    expect(state.imageError).toContain('无需独立制图');
  });
  it('rechecks the saved catalog before paid creation and rejects mismatched input IDs', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const assets = catalog(),
      document = { assets, shots: [] };
    const initial = {
      script: { name: '测试' },
      document,
      confirmedDocument: document,
      prompts: [],
      tasks: [],
      draftRevision: 1,
      assetsConfirmed: false,
    } as unknown as ProductionWorkspace;
    const updated = structuredClone(initial);
    updated.document.assets[0]!.preparation = {
      ...assets[0]!.preparation!,
      treatment: 'SCENE_DETAIL',
      parentId: 's1',
    };
    updated.confirmedDocument = updated.document;
    updated.assetsConfirmed = true;
    updated.draftRevision = 2;
    vi.mocked(productionApi.workspace)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(updated);
    vi.mocked(productionApi.save).mockResolvedValueOnce({ revision: 2 });
    const state = mount(Workspace, { projectId: 'p', workflowRunId: 'r', mode: 'ASSETS' });
    await settle();
    const settings: CustomizedImageSettings = {
      model: CUSTOMIZED_IMAGE_MODELS[0].id,
      resolution: '2K',
      ratio: '1:1',
      assetIds: ['s0'],
    };
    await call(state, 'generateImages', {
      ...settings,
      inputs: [{ assetId: 'd0', prompt: '图片', references: [] }],
    });
    expect(productionApi.start).not.toHaveBeenCalled();
    expect(productionApi.save).not.toHaveBeenCalled();
    expect(state.imageError).toContain('设置与所选资产不一致');
    await call(state, 'generateImages', settings);
    expect(productionApi.save).toHaveBeenCalledTimes(1);
    expect(productionApi.start).not.toHaveBeenCalled();
    expect(state.imageError).toContain('无需独立制图');
  });
});
