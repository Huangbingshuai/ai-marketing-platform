import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
import Library from './ProductionReferenceLibrary.vue';
import Panel from './ProductionShotRenderPanel.vue';
const assets: ProductionAsset[] = [
  {
    id: 'p',
    kind: 'PRODUCT',
    name: '充电器',
    description: '深灰机身',
    knownFacts: '',
    designNotes: '',
    sourceText: '',
  },
  {
    id: 'c',
    kind: 'CHARACTER',
    name: '周越',
    description: '通勤者',
    knownFacts: '',
    designNotes: '',
    sourceText: '',
  },
  {
    id: 's',
    kind: 'SCENE',
    name: '候车区',
    description: '暖光候车区',
    knownFacts: '',
    designNotes: '',
    sourceText: '',
  },
];
const shot: ProductionShot = {
  id: 'shot',
  title: '到站',
  visual: '站台上的人物',
  shotType: '中景',
  cameraMovement: '固定',
  durationSeconds: 5,
  dialogue: '',
  audio: '',
  atmosphere: '暖调',
  bindings: [{ assetId: 'p', description: '' }],
};
describe('Huobao-style production inspector', () => {
  it('keeps the full category library and bound count without search or explanation controls', async () => {
    const html = await renderToString(
      createSSRApp(Library, { projectId: 'p', assets, shot, locked: false }),
    );
    expect(html).toContain('1/3 已绑定');
    for (const asset of assets) expect(html).toContain(`aria-label="绑定${asset.name}"`);
    expect(html.match(/去生成 →/g)).toHaveLength(1);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    for (const extra of ['搜索镜头素材', '编辑绑定', '查看定义', '全部素材供选择'])
      expect(html).not.toContain(extra);
  });
  it('disables reference changes while tasks are running', async () => {
    const html = await renderToString(
      createSSRApp(Library, { projectId: 'p', assets, shot, locked: true }),
    );
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
  });
  it('offers asset preparation only for bound missing images and keeps ready references previewable', async () => {
    const html = await renderToString(
      createSSRApp(Library, {
        projectId: 'p',
        assets: [
          assets[0]!,
          { ...assets[1]!, image: { assetId: 'image', version: 1 } },
          assets[2]!,
        ],
        shot: {
          ...shot,
          bindings: [
            { assetId: 'p', description: '' },
            { assetId: 'c', description: '' },
          ],
        },
        locked: false,
      }),
    );
    expect(html).toContain('未生成');
    expect(html).toContain('可使用');
    expect(html).toContain('未绑定');
    expect(html).toContain('aria-label="前往资产准备生成充电器图片"');
    expect(html).not.toContain('aria-label="前往资产准备生成周越图片"');
    expect(html).not.toContain('aria-label="前往资产准备生成候车区图片"');
    expect(html).toContain('aria-label="预览周越图片"');
  });
  it('keeps only player, bound reference images and duration/generation in the right inspector', async () => {
    const html = (
      await renderToString(
        createSSRApp(Panel, {
          projectId: 'p',
          assets: [assets[0]!],
          shot,
          prompt: '已保存提示词',
          locked: false,
          editing: false,
          index: 2,
        }),
      )
    ).split('<dialog')[0]!;
    expect(html).toContain('分镜 02');
    expect(html).toContain('绑定参考图');
    expect(html).toContain('分镜时长');
    expect(html).toContain('aria-label="生成当前分镜视频"');
    expect(html).toContain('分镜时长：5秒，沿用已确认分镜');
    expect(html).not.toContain('type="number"');
    for (const extra of ['生成历史', '输出设置', '当前镜头预览', '渲染前设置', '视频分辨率'])
      expect(html).not.toContain(extra);
    expect(html).not.toContain('<video');
  });
});
