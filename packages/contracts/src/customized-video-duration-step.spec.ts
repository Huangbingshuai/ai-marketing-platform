import { describe, expect, it } from 'vitest';
import {
  SEEDANCE_MODEL_OPTIONS,
  customizedVideoRenderIssues,
  validateVideoShotDurationStep,
  type VideoShot,
} from './customized-production';

describe('complete storyboard duration step', () => {
  const plan = (seconds: number) => ({ shots: [{ durationSeconds: seconds } as VideoShot] });
  it('does not coerce historical seconds or accept unknown frozen steps', () => {
    const historical = plan(4.5);
    expect(validateVideoShotDurationStep(historical, undefined)).toBeNull();
    expect(validateVideoShotDurationStep(historical, 1000)).toContain('整数秒');
    expect(historical.shots[0]!.durationSeconds).toBe(4.5);
    for (const step of [500, '1000', true, null])
      expect(validateVideoShotDurationStep(plan(5), step)).toContain('不支持');
    expect(validateVideoShotDurationStep(plan(5), 1000)).toBeNull();
  });
  for (const model of SEEDANCE_MODEL_OPTIONS)
    it(`${model.label} rejects fractional seconds with an actionable whole-second message`, () => {
      const settings = {
        capabilityKey: model.value,
        ratio: '16:9' as const,
        resolution: '720p' as const,
      };
      expect(customizedVideoRenderIssues(settings, 4.5, 0).join()).toContain('整数秒');
      expect(customizedVideoRenderIssues(settings, 4.5, 0).join()).toContain('分镜参数');
      expect(customizedVideoRenderIssues(settings, 5, 0)).toEqual([]);
    });
});
