/** Replaced/paused audio can reject an earlier play promise without a playback failure. */
export function packagingPlaybackError(reason: unknown, stillCurrent: boolean): string | null {
  if (!stillCurrent) return null;
  const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : '';
  if (name === 'AbortError') return null;
  return name === 'NotAllowedError'
    ? '浏览器阻止音频播放，请再次开启试听'
    : '包装音频暂时无法播放，请重新开启试听';
}
