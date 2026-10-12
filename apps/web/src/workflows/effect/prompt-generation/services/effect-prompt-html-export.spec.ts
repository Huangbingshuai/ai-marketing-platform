import type { EffectPromptBatchResult } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { buildEffectPromptHtml } from './effect-prompt-html-export';

const result = (): EffectPromptBatchResult =>
  ({
    sharedPrompt: { compiledContent: '共用约束：不出现字幕。' },
    items: [
      {
        id: 'private-item-id',
        code: 'P031',
        origin: 'AI',
        targetDurationSeconds: 15,
        primaryPurpose: 'PRODUCT_DISPLAY',
        compatiblePurposes: ['PRODUCT_DISPLAY', 'HOOK'],
        content: '【首帧】\n  商品位于桌面。\n\n【0–15 秒】\n镜头缓慢推进。',
        creativeCore: '观察商品纹理',
        dimensions: {
          narrative: '细节观察',
          scene: '厨房',
          persona: '',
          productRelation: '',
          camera: '',
          emotion: '',
        },
        insightBindings: [
          {
            factId: 'private-fact-id',
            valueHash: 'private-hash',
            field: 'SELLING_POINT',
            value: '原料事实',
            role: 'PRIMARY',
          },
        ],
      },
      {
        code: 'P037',
        origin: 'MANUAL',
        targetDurationSeconds: 20,
        primaryPurpose: 'EFFECT',
        compatiblePurposes: ['EFFECT'],
        content: '手工输入正文。',
        creativeCore: '',
        dimensions: {
          narrative: '',
          scene: '',
          persona: '',
          productRelation: '',
          camera: '',
          emotion: '',
        },
        insightBindings: [],
      },
    ],
  }) as unknown as EffectPromptBatchResult;

describe('Prompt HTML 阅读版', () => {
  it('按同批顺序展示全文、时长、来源及可选信息，共用约束只显示一次', () => {
    const batch = result();
    const html = buildEffectPromptHtml('广式腊肠', batch, '2026-10-12T00:00:00.000Z');
    expect(html).toContain('<title>广式腊肠 · Prompt 阅读版</title>');
    expect(html).toContain('共 2 条 · AI 生成 1 条 · 外部导入 1 条');
    expect(html).toContain('2026年10月12日 08:00:00');
    expect(html).toContain('href="#prompt-1">P031</a>');
    expect(html).toContain('href="#prompt-2">P037</a>');
    expect(html.indexOf('id="prompt-1"')).toBeLessThan(html.indexOf('id="prompt-2"'));
    expect(html).toContain(batch.items[0]!.content);
    expect(html).toContain('<span>20 秒</span>');
    expect(html).toContain('还适合：钩子片段');
    expect(html).toContain('<dt>场景变量</dt><dd>厨房</dd>');
    expect(html.match(/共用约束：不出现字幕。/gu)).toHaveLength(1);
    expect(html.match(/<details class="extras">/gu)).toHaveLength(1);
    for (const internal of ['private-item-id', 'private-fact-id', 'private-hash', '待补齐'])
      expect(html).not.toContain(internal);
  });

  it('将所有用户内容作为纯文本转义，不加载外部资源或执行脚本', () => {
    const batch = result();
    const unsafe =
      '</style><script>alert("x")</script><img src="https://invalid.example/x"> & \'文本\'';
    batch.items[0]!.content = unsafe;
    batch.items[0]!.code = unsafe;
    batch.items[0]!.creativeCore = unsafe;
    batch.items[0]!.dimensions.scene = unsafe;
    batch.items[0]!.insightBindings[0]!.value = unsafe;
    batch.sharedPrompt!.compiledContent = unsafe;
    const html = buildEffectPromptHtml(unsafe, batch, '2026-10-12T00:00:00Z');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&amp; &#39;文本&#39;');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<img|<link|onerror=/u);
    expect(html).not.toContain(unsafe);
  });

  it('不截断长正文或批次数量，空辅助内容不造占位，支持离线打印及窄屏', () => {
    const batch = result();
    delete batch.sharedPrompt;
    const longContent = '完整长正文\n'.repeat(3000);
    batch.items = Array.from({ length: 100 }, (_, index) => ({
      ...batch.items[1]!,
      code: `P${index + 1}`,
      content: longContent,
    }));
    const html = buildEffectPromptHtml('', batch, 'invalid-time');
    expect(html).toContain('当前商品 · Prompt 阅读版');
    expect(html.match(/<article /gu)).toHaveLength(100);
    expect(html).toContain(longContent);
    expect(html).not.toContain('class="extras"');
    expect(html).not.toContain('批次共用提示词');
    expect(html).toContain('@media print');
    expect(html).toContain('@media(max-width:600px)');
  });
});
