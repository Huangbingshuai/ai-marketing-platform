/** Replaced/paused audio can reject an earlier play promise without a playback failure. */
export function packagingPlaybackError(reason: unknown, stillCurrent: boolean): string | null {
  if (!stillCurrent) return null;
  const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : '';
  if (name === 'AbortError') return null;
  return name === 'NotAllowedError'
    ? '浏览器阻止音频播放，请暂停后重新点击播放器的播放按钮'
    : '包装音频暂时无法播放，请暂停后重新点击播放器的播放按钮';
}
/** Normal readiness/time updates must never restart decoding by chasing the timeline clock. */
export function positionPackagingAudio(
  element: { currentTime: number },
  targetTime: number,
  seekRequested: boolean,
  tolerance = 0,
): void {
  if (!seekRequested || !Number.isFinite(targetTime)) return;
  const target = Math.max(0, targetTime);
  if (Math.abs(element.currentTime - target) <= Math.max(0, tolerance)) return;
  element.currentTime = target;
}
