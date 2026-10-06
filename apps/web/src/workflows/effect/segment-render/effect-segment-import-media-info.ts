type VideoSize = { width?: number; height?: number };

/** Readable metadata only; the exact media duration remains authoritative for editing. */
export function importVideoDuration(duration: number | null | undefined): string {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? String(Math.round(duration * 10) / 10)
    : '—';
}

export function importVideoPreviewStyle(size: VideoSize) {
  const ratio = validSize(size) ? size.width / size.height : 16 / 9;
  return {
    aspectRatio: String(ratio),
    width: `min(100%, ${240 * ratio}px, ${30 * ratio}dvh)`,
  };
}

const validSize = (size: VideoSize): size is { width: number; height: number } =>
  Number.isInteger(size.width) &&
  Number.isInteger(size.height) &&
  size.width! > 0 &&
  size.height! > 0;

export function importVideoResolution(size: VideoSize): string {
  return validSize(size) ? `${Math.min(size.width, size.height)}p` : '—';
}

export function importVideoAspectRatio(size: VideoSize): string {
  if (!validSize(size)) return '—';
  // Recognize standard display ratios despite one-pixel encoder rounding.
  const ratios = [
    [16, 9],
    [9, 16],
    [4, 3],
    [3, 4],
    [1, 1],
    [21, 9],
  ] as const;
  const matched = ratios.find(
    ([w, h]) => Math.abs(size.width / size.height / (w / h) - 1) <= 0.005,
  );
  if (matched) return matched.join(':');
  let a = size.width;
  let b = size.height;
  while (b) [a, b] = [b, a % b];
  return `${size.width / a}:${size.height / a}`;
}

export function importVideoFrameRate(frameRate: number | null | undefined): string {
  return typeof frameRate === 'number' && Number.isFinite(frameRate) && frameRate > 0
    ? `${Number(frameRate.toFixed(2))} fps`
    : '—';
}
