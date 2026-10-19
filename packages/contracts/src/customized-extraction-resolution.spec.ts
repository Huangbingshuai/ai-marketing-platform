import { describe, expect, it } from 'vitest';
import {
  applyCustomizedBriefIssueAlternative as apply,
  type CustomizedBriefIssue,
} from './customized-extraction';

const base = '容量未确认：430mL或480mL；重量待确认：312g或320g；未确认附赠配件；性能尚无测试结论。';
const issue = (id: string, before: string, replacements: string[]): CustomizedBriefIssue => ({
  id,
  field: 'productSpecifications',
  message: id,
  blocking: true,
  sourceIds: ['doc'],
  resolution: { schemaVersion: 1, baseValue: base, before, replacements },
  alternatives: replacements.map((value) => base.replace(before, value)),
});
const capacity = issue('capacity', '容量未确认：430mL或480mL', ['容量430mL', '容量480mL']);
const weight = issue('weight', '重量待确认：312g或320g', ['重量312g', '重量320g']);

describe('scoped extraction alternatives', () => {
  it('applies disjoint choices in either order without resetting earlier choices or unknown facts', () => {
    for (const pair of [
      [capacity, weight],
      [weight, capacity],
    ]) {
      let value = base;
      for (const item of pair) {
        const result = apply(value, item!, 0);
        expect(result.ok).toBe(true);
        if (result.ok) value = result.value;
      }
      expect(value).toBe('容量430mL；重量312g；未确认附赠配件；性能尚无测试结论。');
    }
  });
  it('preserves unrelated manual edits', () => {
    const result = apply(base + ' 包装等待设计。', capacity, 1);
    expect(result).toEqual({
      ok: true,
      value: base.replace(capacity.resolution!.before, '容量480mL') + ' 包装等待设计。',
    });
  });
  it('rejects legacy full-field choices rather than treating them as safe patches', () => {
    const { resolution: _resolution, ...legacy } = capacity;
    expect(apply(base, legacy, 0)).toEqual({ ok: false, reason: 'LEGACY' });
  });
  it.each([base.replace('430mL或480mL', '已人工确认450mL'), base + capacity.resolution!.before])(
    'rejects a changed or ambiguous current fragment',
    (current) => {
      expect(apply(current, capacity, 0)).toEqual({ ok: false, reason: 'STALE' });
    },
  );
  it('rejects mismatched full-field values, invalid indexes and ambiguous baseline fragments', () => {
    expect(apply(base, { ...capacity, alternatives: ['被串扰的整段字段', '另一候选'] }, 0).ok).toBe(
      false,
    );
    expect(apply(base, capacity, 2).ok).toBe(false);
    expect(apply(base, capacity, -1).ok).toBe(false);
    expect(
      apply(base, { ...capacity, resolution: { ...capacity.resolution!, before: '确认' } }, 0).ok,
    ).toBe(false);
  });
  it('only applies an empty baseline insertion when the field is still empty', () => {
    const empty = {
      ...capacity,
      alternatives: ['430mL', '480mL'],
      resolution: {
        schemaVersion: 1 as const,
        baseValue: '',
        before: '',
        replacements: ['430mL', '480mL'],
      },
    };
    expect(apply('', empty, 0)).toEqual({ ok: true, value: '430mL' });
    expect(apply('人工补充', empty, 0)).toEqual({ ok: false, reason: 'STALE' });
  });
});
