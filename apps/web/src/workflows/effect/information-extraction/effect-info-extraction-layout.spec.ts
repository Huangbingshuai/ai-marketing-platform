import { describe, expect, it } from 'vitest';

import pageSource from './EffectInfoExtractionNodePage.vue?raw';

describe('effect info extraction result layout', () => {
  it('always renders the complete extraction form and keeps ungenerated fields empty', () => {
    expect(pageSource).toContain('class="product-info-layout"');
    expect(pageSource).toContain('class="result-grid"');
    expect(pageSource).toContain("currentState.value?.result?.[field] ?? ''");
    expect(pageSource).toContain("coreSellingPoints: ['']");
    expect(pageSource).not.toContain('v-else-if="!currentState.result"');
  });

  it('uses the heading action as the only extraction trigger instead of a lower empty-state button', () => {
    expect(pageSource).not.toContain('empty-result-card');
    expect(pageSource).not.toContain('processing-card');
    expect(pageSource).not.toContain('尚未生成提炼结果');
    expect(pageSource.match(/@click="runCurrentExtraction"/g)).toHaveLength(3);
  });
});
