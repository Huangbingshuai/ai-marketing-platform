import { describe, expect, it } from 'vitest';
import { seekLocalVideo } from './local-replace-media';

describe('local replacement media synchronization', () => {
  it('seeks a loaded local video when the workbench playhead changes', () => {
    const video = { readyState: 1, duration: 32, currentTime: 0 };
    for (const time of [4, 16, 0, 31.9]) {
      seekLocalVideo(video, time);
      expect(video.currentTime).toBe(time);
    }
  });
  it('bounds timeline controls to actual media duration and ignores incomplete metadata', () => {
    const video = { readyState: 1, duration: 1.17, currentTime: 0 };
    seekLocalVideo(video, 10);
    expect(video.currentTime).toBe(1.17);
    seekLocalVideo(video, -1);
    expect(video.currentTime).toBe(0);
    video.readyState = 0;
    seekLocalVideo(video, 0.7);
    expect(video.currentTime).toBe(0);
    video.readyState = 1;
    seekLocalVideo(video, NaN);
    expect(video.currentTime).toBe(0);
  });
  it('does not seek backwards on rounded native playback events', () => {
    let position = 4.04,
      writes = 0;
    const video = {
      readyState: 2,
      duration: 32,
      get currentTime() {
        return position;
      },
      set currentTime(value: number) {
        position = value;
        writes++;
      },
    };
    seekLocalVideo(video, 4);
    expect(writes).toBe(0);
    expect(position).toBe(4.04);
    seekLocalVideo(video, 4.1);
    expect(writes).toBe(1);
    expect(position).toBe(4.1);
  });
});
