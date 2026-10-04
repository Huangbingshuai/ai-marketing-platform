import {
  effectTemplateMixSlotDurationMessage,
  effectTemplateMixSlotDurationValid,
} from '@ai-marketing/contracts';

/** An attempted step must still report its boundary even when the number cannot change. */
export function stepTemplateMixDuration(
  duration: number,
  maximum: number | null,
  direction: 1 | -1,
): { duration: number | null; notice: string | null } {
  if (!effectTemplateMixSlotDurationValid(duration, maximum))
    return { duration: null, notice: effectTemplateMixSlotDurationMessage(maximum) };
  if (direction === 1 && duration >= maximum! - 1e-6)
    return { duration, notice: `已达到槽位时长上限 ${maximum} 秒，不能继续增加` };
  if (direction === -1 && duration <= 4 + 1e-6)
    return { duration, notice: '已达到槽位时长下限 4 秒，不能继续减少' };
  return {
    duration: Math.max(4, Math.min(maximum!, Math.round((duration + direction * 0.1) * 10) / 10)),
    notice: null,
  };
}
