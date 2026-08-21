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

  it('runs only the selected product and exposes progress, warnings and conflict recovery', () => {
    expect(pageSource).not.toContain('全部提炼');
    expect(pageSource).not.toContain('runBatchExtraction');
    expect(pageSource).not.toContain('batchBusy');
    expect(pageSource).toContain('currentState.progress');
    expect(pageSource).toContain('currentState.warnings');
    expect(pageSource).toContain('加载最新结果');
  });
});
