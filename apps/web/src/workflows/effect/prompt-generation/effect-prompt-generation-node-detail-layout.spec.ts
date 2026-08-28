import { describe, expect, it } from 'vitest';

import pageSource from './EffectPromptGenerationNodePage.vue?raw';

describe('effect prompt workflow node detail layout', () => {
  it('groups safe detail data into input, output, and execution sections', () => {
    expect(pageSource).toContain('class="node-detail-section"');
    expect(pageSource).toContain("section.kind !== 'EXECUTION'");
    expect(pageSource).toContain("section.kind === 'INPUT'");
    expect(pageSource).toContain("section.kind === 'OUTPUT'");
    expect(pageSource).toContain("block.kind === 'TEXT_CONTENT'");
    expect(pageSource).toContain("block.kind === 'CREATIVE_SAMPLE_LIST'");
    expect(pageSource).toContain('当前服务返回的是兼容格式');
  });

  it('shows counts and representative samples without exposing internal identifiers', () => {
    expect(pageSource).toContain('其余 {{ block.remainingCount }} 条未展开');
    expect(pageSource).toContain('创意主线');
    expect(pageSource).toContain('兼容用途');
    expect(pageSource).not.toContain('item.slotId');
    expect(pageSource).not.toContain('item.factId');
    expect(pageSource).not.toContain('semanticSignature');
    expect(pageSource).not.toContain('visualSignature');
  });
});
