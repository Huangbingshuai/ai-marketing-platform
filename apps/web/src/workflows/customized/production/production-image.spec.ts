import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { CUSTOMIZED_IMAGE_MODELS, type ProductionAsset } from '@ai-marketing/contracts';
import Dialog from './ProductionRenderDialog.vue';
import Composer from './ProductionImageComposer.vue';
import { defaultAssetImagePrompt } from './production-image-input';
import { productionApi } from './production.api';

const asset: ProductionAsset = {
  id: 'product',
  kind: 'PRODUCT',
  name: '陶瓷杯',
  description: '暖白釉面陶瓷杯',
  knownFacts: '陶瓷材质',
  designNotes: '包装待确认',
  sourceText: '测试资料',
  imageRequirements: '完整公共形象',
};
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
});
describe('asset image production', () => {
  it('prefills a multi-view sheet for new images without rewriting previous custom prompts', async () => {
    const html = await renderToString(
      createSSRApp(Composer, { asset, projectId: 'project', workflowRunId: 'run' }),
    );
    expect(html).toContain('多视角设定图');
    expect(html).toContain('正视、侧视、三分之四角度');
    expect(html).toContain('必须不展示该部位');
    expect(html).toContain('不能排成多套候选方案');
    expect(defaultAssetImagePrompt({ ...asset, kind: 'CHARACTER' })).toContain('面部特写');
    expect(defaultAssetImagePrompt({ ...asset, kind: 'SCENE' })).toContain('同一个空间结构');
    expect(defaultAssetImagePrompt({ ...asset, kind: 'PROP' })).toContain('同一道具');
  });
  it('prefills the selected asset prompt and restores its previous model/input', async () => {
    const html = await renderToString(
      createSSRApp(Composer, {
        asset,
        projectId: 'project',
        workflowRunId: 'run',
        settings: {
          model: CUSTOMIZED_IMAGE_MODELS[1].id,
          resolution: '1.5K',
          ratio: '2:3',
          assetIds: ['product'],
          inputs: [{ assetId: 'product', prompt: '本次暖白釉面陶瓷杯，细腻侧光', references: [] }],
        },
      }),
    );
    expect(html).toContain('本次暖白釉面陶瓷杯，细腻侧光');
    expect(html).toContain('Seedream 5.0 Flash');
    expect(html).toContain('添加参考图片');
    expect(html).toContain('图片生成参数');
    expect(html).not.toContain('批量生成');
    expect(defaultAssetImagePrompt(asset)).toContain('完整公共形象');
  });
  it('renders shared production settings, actual objects and a usable image action', async () => {
    const html = await renderToString(
      createSSRApp(Dialog, { open: true, type: 'IMAGE', assets: [asset] }),
    );
    for (const text of [
      'Seedream 5.0 Pro',
      'Seedream 5.0 Flash',
      '图片清晰度',
      '图片画幅',
      '陶瓷杯',
      '完整公共形象',
      '生成此图片',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('图片生成暂不可用');
    expect(html).not.toContain('图片生成服务尚未接通');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('已选 1 / 1');
  });
  it('retains the old image while regenerating and shows actionable errors', async () => {
    const html = await renderToString(
      createSSRApp(Dialog, {
        open: true,
        type: 'IMAGE',
        assets: [{ ...asset, image: { assetId: 'old', version: 1 } }],
        error: '图片服务未配置',
      }),
    );
    expect(html).toContain('完成前保留原图');
    expect(html).toContain('图片服务未配置');
    expect(html).toContain('重新生成此图片');
  });
  it('keeps multi-asset selection available in batch mode', async () => {
    const html = await renderToString(
      createSSRApp(Dialog, {
        open: true,
        type: 'IMAGE',
        assets: [asset, { ...asset, id: 'second', name: '第二项资产' }],
      }),
    );
    expect(html).toContain('批量生成资产图片');
    expect(html).toContain('已选 2 / 2');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('开始生成图片');
  });
  it('keeps video rendering explicitly unavailable', async () => {
    const html = await renderToString(
      createSSRApp(Dialog, { open: true, type: 'VIDEO', assets: [] }),
    );
    expect(html).toContain('视频渲染暂不可用');
    expect(html).not.toContain('开始生成图片');
  });
  it('submits a frozen model and selected object IDs through the existing API', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { id: 'task', operation: 'IMAGE', status: 'QUEUED' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const settings = {
      model: CUSTOMIZED_IMAGE_MODELS[1].id,
      resolution: '1.5K',
      ratio: '16:9',
      assetIds: [asset.id],
    } as const;
    await productionApi.start('project', 'run', 7, 'IMAGE', undefined, undefined, undefined, {
      ...settings,
      assetIds: [...settings.assetIds],
    });
    const input = fetch.mock.calls[0]![1];
    expect(JSON.parse(input.body)).toMatchObject({
      workflowRunId: 'run',
      expectedRevision: 7,
      operation: 'IMAGE',
      imageSettings: settings,
    });
    expect(input.credentials).toBe('include');
  });
});
