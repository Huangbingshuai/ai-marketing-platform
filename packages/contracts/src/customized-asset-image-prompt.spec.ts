import { expect, it } from 'vitest';
import type { ProductionAsset } from './customized-production';
import { defaultCustomizedAssetImagePrompt } from './customized-asset-image-prompt';

const asset: ProductionAsset = {
  id: 'person',
  kind: 'CHARACTER',
  name: '林晓',
  description: '编辑部新同事',
  knownFacts: '杯子的主人',
  designNotes: '克制写实',
  sourceText: '会议室',
};

it('carries confirmed appearance, clothing, view requirements and unresolved boundaries into image inputs', () => {
  const prompt = defaultCustomizedAssetImagePrompt({
    ...asset,
    preparation: {
      aliases: [],
      usage: '主人公',
      treatment: 'INDEPENDENT',
      parentId: null,
      sources: [],
      details: [
        { key: 'appearance', value: '齐肩黑直发' },
        { key: 'styling', value: '浅米色衬衫、深灰西装裤、银圈手表' },
      ],
      images: [{ name: '人物设定', purpose: '跨镜一致', requirements: '同一服装的正侧背面' }],
      questions: [{ field: 'structure', question: '连接方式未确认', impact: '不得画螺纹与拆装' }],
    },
  });
  for (const required of [
    '齐肩黑直发',
    '深灰西装裤',
    '银圈手表',
    '同一服装的正侧背面',
    '不得画螺纹与拆装',
  ])
    expect(prompt).toContain(required);
  expect(prompt).not.toContain('undefined');
});

it('continues to support historical assets without structured preparation', () => {
  expect(defaultCustomizedAssetImagePrompt(asset)).toContain('对象名称：林晓');
  expect(defaultCustomizedAssetImagePrompt(asset)).not.toContain('undefined');
});
