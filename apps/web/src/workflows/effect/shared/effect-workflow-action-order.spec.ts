import { describe, expect, it } from 'vitest';

import extraction from '../information-extraction/EffectInfoExtractionNodePage.vue?raw';
import prompt from '../prompt-generation/EffectPromptGenerationNodePage.vue?raw';
import mix from '../template-mix/EffectTemplateMixNodePage.vue?raw';

describe('effect workflow viewer action order', () => {
  it.each([
    ['information extraction', extraction, 1],
    ['prompt generation', prompt, 1],
    ['mix, packaging and failed mix', mix, 3],
  ] as const)('keeps every workflow viewer last in %s', (_, source, expectedCount) => {
    const viewers = [...source.matchAll(/<button\b[\s\S]*?<\/button>/gu)]
      .filter(([button]) => button.includes('查看工作流'));
    expect(viewers).toHaveLength(expectedCount);
    for (const viewer of viewers) {
      const tail = source.slice(viewer.index! + viewer[0].length);
      expect(/^\s*<\/div>/u.test(tail)).toBe(true);
    }
  });
});
