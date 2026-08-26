import { describe, expect, it } from 'vitest';

import pageSource from './EffectPromptGenerationNodePage.vue?raw';

describe('effect prompt V4 insight utilization layout', () => {
  it('shows authoritative insight coverage and per-item source labels', () => {
    expect(pageSource).toContain('提炼信息利用');
    expect(pageSource).toContain('currentMetrics.insightCoverage.covered.length');
    expect(pageSource).toContain('currentMetrics.insightCoverage.missing.length');
    expect(pageSource).toContain('currentMetrics.insightCoverage.deferred.length');
    expect(pageSource).toContain('currentMetrics.insightCoverage.appliedConstraints.length');
    expect(pageSource).toContain('class="insight-source-tags"');
    expect(pageSource).toContain('itemInsightSources(item)');
  });

  it('renders the mapping and coverage stages in the public sub-workflow', () => {
    expect(pageSource).toContain("['INSIGHT_MAPPING']");
    expect(pageSource).toContain("['INSIGHT_COVERAGE']");
    expect(pageSource).toContain('连接受众、痛点、场景、卖点与营销目标');
    expect(pageSource).toContain('按缺少的片段类型和提炼事实定向补齐');
  });
});
