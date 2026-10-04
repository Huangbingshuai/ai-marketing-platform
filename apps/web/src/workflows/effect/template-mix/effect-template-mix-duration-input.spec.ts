import { describe, expect, it } from 'vitest';
import { stepTemplateMixDuration } from './effect-template-mix-duration-input';

describe('slot duration increment feedback', () => {
  it.each([8, 10, 15])(
    'reports attempts to increase beyond the dynamic %s-second cap',
    (maximum) => {
      const result = stepTemplateMixDuration(maximum, maximum, 1);
      expect(result.duration).toBe(maximum);
      expect(result.notice).toContain(`上限 ${maximum} 秒`);
      expect(stepTemplateMixDuration(maximum, maximum, 1)).toEqual(result);
    },
  );
  it('reports attempts to decrease below four seconds, including a four-second source', () => {
    expect(stepTemplateMixDuration(4, 10, -1)).toEqual({
      duration: 4,
      notice: '已达到槽位时长下限 4 秒，不能继续减少',
    });
    expect(stepTemplateMixDuration(4, 4, -1).notice).toContain('下限');
    expect(stepTemplateMixDuration(4, 4, 1).notice).toContain('上限');
  });
  it('steps in tenths without a warning when approaching or leaving a boundary', () => {
    expect(stepTemplateMixDuration(9.9, 10, 1)).toEqual({ duration: 10, notice: null });
    expect(stepTemplateMixDuration(4.1, 10, -1)).toEqual({ duration: 4, notice: null });
    expect(stepTemplateMixDuration(10, 10, -1)).toEqual({ duration: 9.9, notice: null });
    expect(stepTemplateMixDuration(4, 10, 1)).toEqual({ duration: 4.1, notice: null });
  });
  it('rejects incomplete or invalid input instead of saving a step from it', () => {
    for (const value of [NaN, 0, 3.9, 10.1]) {
      expect(stepTemplateMixDuration(value, 10, 1).duration).toBeNull();
      expect(stepTemplateMixDuration(value, 10, 1).notice).toBeTruthy();
    }
    expect(stepTemplateMixDuration(4, null, 1).duration).toBeNull();
  });
});
