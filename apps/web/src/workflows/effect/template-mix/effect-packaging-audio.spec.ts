import { describe, expect, it } from 'vitest';
import { packagingPlaybackError } from './effect-packaging-audio';

describe('packaging audio play promise', () => {
  it('does not disable preview when a sentence switch or pause aborts pending playback', () => {
    expect(packagingPlaybackError({ name: 'AbortError' }, true)).toBeNull();
  });
  it('ignores obsolete media, project and disabled-preview promises', () => {
    expect(packagingPlaybackError({ name: 'NotAllowedError' }, false)).toBeNull();
    expect(packagingPlaybackError(new Error('old media'), false)).toBeNull();
  });
  it('distinguishes permission refusal from unsupported or unreadable audio', () => {
    expect(packagingPlaybackError({ name: 'NotAllowedError' }, true)).toContain('浏览器阻止');
    expect(packagingPlaybackError({ name: 'NotSupportedError' }, true)).toContain('暂时无法播放');
  });
});
