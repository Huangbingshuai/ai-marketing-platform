import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import WorkflowExtractionActions from '../../../platform/workflow/components/WorkflowExtractionActions.vue';

import extraction from '../information-extraction/EffectInfoExtractionNodePage.vue?raw';
import prompt from '../prompt-generation/EffectPromptGenerationNodePage.vue?raw';
import mix from '../template-mix/EffectTemplateMixNodePage.vue?raw';

describe('effect workflow viewer action order', () => {
  it('keeps the extraction viewer last through its shared action component', async () => {
    expect(extraction).toMatch(/<WorkflowExtractionActions\b[\s\S]*?\/>\s*<\/div>/u);
    expect(extraction).toContain('@details="openGraphDialog"');
    const html = await renderToString(
      createSSRApp(WorkflowExtractionActions, { label: '重新提炼', reextract: true }),
    );
    expect(html.match(/<button\b/gu)).toHaveLength(2);
    expect(html.indexOf('查看工作流')).toBeGreaterThan(html.indexOf('重新提炼'));
    expect(html).toContain('aria-haspopup="dialog"');
  });
  it.each([
    ['prompt generation', prompt, 1],
    ['mix and packaging', mix, 2],
  ] as const)('keeps every workflow viewer last in %s', (_, source, expectedCount) => {
    const viewers = [...source.matchAll(/<button\b[\s\S]*?<\/button>/gu)].filter(([button]) =>
      button.includes('查看工作流'),
    );
    expect(viewers).toHaveLength(expectedCount);
    for (const viewer of viewers) {
      const tail = source.slice(viewer.index! + viewer[0].length);
      expect(/^\s*<\/div>/u.test(tail)).toBe(true);
    }
  });
});
