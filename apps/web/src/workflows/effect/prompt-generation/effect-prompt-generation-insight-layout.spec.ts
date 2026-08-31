import { describe, expect, it } from 'vitest';

import pageSource from './EffectPromptGenerationNodePage.vue?raw';

describe('effect prompt insight utilization layout', () => {
  it('shows each item fact basis without rendering the batch coverage component', () => {
    expect(pageSource).not.toContain('aria-label="配额与提炼信息覆盖"');
    expect(pageSource).not.toContain('currentMetrics.insightCoverage.covered.length');
    expect(pageSource).not.toContain('currentMetrics.insightCoverage.missing.length');
    expect(pageSource).toContain('查看提炼信息依据');
    expect(pageSource).toContain('itemInsightFactGroups(item)');
    expect(pageSource).toContain('画面直接依据');
    expect(pageSource).toContain('创意背景依据');
    expect(pageSource).toContain('{{ fact.value }}');
  });

  it('renders the mapping and coverage stages in the public sub-workflow', () => {
    expect(pageSource).toMatch(/\bINSIGHT_MAPPING\b/u);
    expect(pageSource).toMatch(/\bSHARED_PROMPT_COMPILATION\b/u);
    expect(pageSource).toMatch(/\bINSIGHT_COVERAGE\b/u);
    expect(pageSource).toContain('连接受众、痛点、场景、卖点与营销目标');
    expect(pageSource).toContain('按缺少的片段类型和提炼事实定向补齐');
  });
});
