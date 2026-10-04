import { describe, expect, it } from 'vitest';
import type { FinalOutputItem, FinalOutputRun } from '@ai-marketing/contracts';
import { outputFileDescription, outputPackagingLabel, outputTemplateStatus } from './effect-final-output-status';

const item = (fields: Partial<FinalOutputItem> = {}) => ({ duration: 38, unpackaged: true, ...fields }) as FinalOutputItem;
describe('concise final output status', () => {
  it('hides the packaging label after the current engineering package finishes, even for an old file', () => {
    expect(outputPackagingLabel(item({ currentPackagingReady: true, stale: true }))).toBeNull();
    expect(outputPackagingLabel(item({ currentPackagingReady: true, unpackaged: false }))).toBeNull();
  });
  it('uses one 未包装 label for all unpackaged outputs and supports old responses', () => {
    expect(outputPackagingLabel(item({ currentPackagingReady: false }))?.text).toBe('未包装');
    expect(outputPackagingLabel(item())?.text).toBe('未包装');
    expect(outputPackagingLabel(item({ unpackaged: false }))).toBeNull();
    const legacy = item();
    delete legacy.unpackaged;
    expect(outputPackagingLabel(legacy)).toBeNull();
  });
  it('keeps file metadata short regardless of package and stale state', () => {
    expect(outputFileDescription(item({ currentPackagingReady: true, stale: true }), 'COMPLETED'))
      .toBe('38.0 秒 · H.264 / AAC');
    expect(outputFileDescription(item(), 'COMPLETED')).toBe('38.0 秒 · H.264 / AAC');
    expect(outputFileDescription(item(), 'PENDING_RENDER')).toBe('预计 38.0 秒 · 待导出');
  });
  it('prioritizes a real update warning over a completed batch label', () => {
    const run = { status: 'COMPLETED', counts: { total: 3, stale: 2 } } as FinalOutputRun;
    expect(outputTemplateStatus(run)).toBe('2 条成片待更新');
    run.counts.stale = 0;
    expect(outputTemplateStatus(run)).toBe('3 条成片 · 已完成');
  });
});
