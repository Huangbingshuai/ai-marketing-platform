export type TimelineSplitRange = {
  at: number;
  leftDuration: number;
  rightDuration: number;
};

/** Snap the cut to a frame and refuse empty or sub-frame results at either edge. */
export const splitRangeAtPlayhead = (
  start: number,
  duration: number,
  playhead: number,
  fps: number,
): TimelineSplitRange | null => {
  if (![start, duration, playhead, fps].every(Number.isFinite) || duration <= 0 || fps <= 0)
    return null;
  const end = start + duration;
  const at = Math.round(playhead * fps) / fps;
  const epsilon = 1 / fps / 100;
  if (at <= start + epsilon || at >= end - epsilon) return null;
  const leftDuration = at - start;
  const rightDuration = end - at;
  return leftDuration > 0 && rightDuration > 0 ? { at, leftDuration, rightDuration } : null;
};
