import { describe, expect, it } from 'vitest';

import { TimelineVideoSeekQueue } from './effect-template-mix-video-seek';

const video = () => ({ currentTime: 0, readyState: 4, seeking: false, src: 'clip-a' });

describe('timeline video seek queue', () => {
  it('coalesces fast scrubbing to the latest target while a seek is decoding', () => {
    const queue = new TimelineVideoSeekQueue();
    const player = video();
    expect(queue.request(player, 2, 0.01)).toBe(false);
    expect(player.currentTime).toBe(2);
    queue.request(player, 5, 0.01);
    queue.request(player, 9, 0.01);
    expect(player.currentTime).toBe(2);
    expect(queue.complete(player, 0.01)).toBe(false);
    expect(player.currentTime).toBe(9);
    expect(queue.complete(player, 0.01)).toBe(true);
  });

  it('waits for metadata and discards targets from a replaced source', () => {
    const queue = new TimelineVideoSeekQueue();
    const player = video();
    player.readyState = 0;
    queue.request(player, 8, 0.01);
    player.src = 'clip-b';
    player.readyState = 4;
    expect(queue.flush(player, 0.01)).toBe(true);
    expect(player.currentTime).toBe(0);
    queue.request(player, 3, 0.01);
    expect(player.currentTime).toBe(3);
  });
});
