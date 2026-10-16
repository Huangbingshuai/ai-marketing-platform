export type VideoTrimRange = { start: number; offset: number; duration: number };

/** Trim one clip, not its neighbours. The opposite timeline/source edge stays anchored. */
export const resizeVideoRangeAtEdge = (
  original: VideoTrimRange,
  sourceDuration: number,
  side: 'LEFT' | 'RIGHT',
  delta: number,
  fps: number,
): VideoTrimRange | null => {
  const { start, offset, duration } = original;
  if (
    ![start, offset, duration, sourceDuration, delta, fps].every(Number.isFinite) ||
    start < 0 ||
    offset < 0 ||
    duration <= 0 ||
    fps <= 0 ||
    sourceDuration <= 0 ||
    offset + duration > sourceDuration + 0.001
  )
    return null;
  const minimum = Math.min(1 / fps, duration);
  const movement = Math.round(delta * fps) / fps;
  if (side === 'LEFT') {
    const sourceEnd = offset + duration;
    const nextOffset = Math.max(
      Math.max(0, offset - start),
      Math.min(sourceEnd - minimum, offset + movement),
    );
    return {
      start: Math.max(0, start + nextOffset - offset),
      offset: nextOffset,
      duration: sourceEnd - nextOffset,
    };
  }
  return {
    start,
    offset,
    duration: Math.max(minimum, Math.min(sourceDuration - offset, duration + movement)),
  };
};

/** Freeze implicit positions before changing duration, so this is not a ripple edit. */
export const startsAfterIndependentTrim = (
  ranges: readonly { id: string; start: number }[],
  slotId: string,
  start: number,
): Record<string, number> =>
  Object.fromEntries(ranges.map((range) => [range.id, range.id === slotId ? start : range.start]));
