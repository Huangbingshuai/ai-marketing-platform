import { describe, expect, it } from 'vitest';

import pageSource from './EffectPromptGenerationNodePage.vue?raw';

describe('effect prompt V4 insight utilization layout', () => {
  it('keeps per-item source labels without rendering the batch coverage component', () => {
    expect(pageSource).not.toContain('aria-label="配额与提炼信息覆盖"');
    expect(pageSource).not.toContain('currentMetrics.insightCoverage.covered.length');
    expect(pageSource).not.toContain('currentMetrics.insightCoverage.missing.length');
    expect(pageSource).toContain('class="insight-source-tags"');
    expect(pageSource).toContain('itemInsightSources(item)');
  });

  it('renders the mapping and coverage stages in the public sub-workflow', () => {
    expect(pageSource).toMatch(/\bINSIGHT_MAPPING\b/u);
    expect(pageSource).toMatch(/\bSHARED_PROMPT_COMPILATION\b/u);
    expect(pageSource).toMatch(/\bINSIGHT_COVERAGE\b/u);
    expect(pageSource).toContain('连接受众、痛点、场景、卖点与营销目标');
    expect(pageSource).toContain('按缺少的片段类型和提炼事实定向补齐');
  });
});
