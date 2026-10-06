import { describe, expect, it } from 'vitest';

import { prepareTimelineVideo, TimelineVideoSeekQueue } from './effect-template-mix-video-seek';

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

  it('queues the incoming trim point before metadata and decodes it before handoff', () => {
    const queue = new TimelineVideoSeekQueue();
    const player = { ...video(), preload: 'metadata', readyState: 0 };
    prepareTimelineVideo(player, queue, 2.5, 0.04);
    expect(player.preload).toBe('auto');
    expect(player.currentTime).toBe(0);
    expect(queue.isSettled(player)).toBe(false);
    player.readyState = 4;
    expect(queue.flush(player, 0.04)).toBe(false);
    expect(player.currentTime).toBe(2.5);
    expect(queue.isSettled(player)).toBe(false);
    expect(queue.complete(player, 0.04)).toBe(true);
    expect(queue.isSettled(player)).toBe(true);
  });

  it('retains buffered data and a prepared frame without reloading or re-seeking', () => {
    const queue = new TimelineVideoSeekQueue();
    let assignments = 0;
    let reloads = 0;
    let time = 1.25;
    const player = {
      ...video(),
      preload: 'metadata',
      get currentTime() {
        return time;
      },
      set currentTime(value: number) {
        time = value;
        assignments++;
      },
      load() {
        reloads++;
      },
    };
    prepareTimelineVideo(player, queue, 1.25, 0.04);
    prepareTimelineVideo(player, queue, 1.25, 0.04);
    expect(assignments).toBe(0);
    expect(reloads).toBe(0);
    expect(queue.isSettled(player)).toBe(true);
  });

  it('repositions a previously played upcoming clip without reloading its source', () => {
    const queue = new TimelineVideoSeekQueue();
    const player = { ...video(), preload: 'metadata', currentTime: 8 };
    prepareTimelineVideo(player, queue, 1.5, 0.04);
    expect(player.currentTime).toBe(1.5);
    expect(queue.isSettled(player)).toBe(false);
    queue.complete(player, 0.04);
    expect(queue.isSettled(player)).toBe(true);
  });

  it('does not consider HAVE_CURRENT_DATA ready while a seek remains in flight', () => {
    const queue = new TimelineVideoSeekQueue();
    const player = video();
    queue.request(player, 3, 0.04);
    expect(queue.isSettled(player)).toBe(false);
    player.seeking = true;
    queue.complete(player, 0.04);
    expect(queue.isSettled(player)).toBe(false);
    player.seeking = false;
    queue.complete(player, 0.04);
    expect(queue.isSettled(player)).toBe(true);
    player.readyState = 1;
    expect(queue.isSettled(player)).toBe(false);
  });
});
