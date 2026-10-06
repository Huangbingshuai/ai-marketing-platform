type SeekableVideo = {
  currentTime: number;
  readyState: number;
  seeking: boolean;
  src: string;
};

type SeekState = {
  source: string;
  inFlight: boolean;
  pendingTime: number | null;
};

/** Keep only the newest scrub target while the browser decodes an earlier seek. */
export class TimelineVideoSeekQueue {
  private states = new WeakMap<SeekableVideo, SeekState>();

  reset(): void {
    this.states = new WeakMap<SeekableVideo, SeekState>();
  }

  isSettled(video: SeekableVideo): boolean {
    const state = this.stateFor(video);
    return video.readyState >= 2 && !video.seeking && !state.inFlight && state.pendingTime === null;
  }

  request(video: SeekableVideo, seconds: number, tolerance: number): boolean {
    const state = this.stateFor(video);
    state.pendingTime = seconds;
    return this.flush(video, tolerance);
  }

  /** Called again by loadedmetadata/seeked; false means the requested frame is still decoding. */
  flush(video: SeekableVideo, tolerance: number): boolean {
    const state = this.stateFor(video);
    if (video.readyState < 1 || video.seeking || state.inFlight) return false;
    const target = state.pendingTime;
    if (target === null) return true;
    state.pendingTime = null;
    if (Math.abs(video.currentTime - target) <= tolerance) return true;
    try {
      video.currentTime = target;
      state.inFlight = true;
      return false;
    } catch {
      // A source can be replaced between metadata and assignment. Retry on readiness.
      state.pendingTime = target;
      return false;
    }
  }

  complete(video: SeekableVideo, tolerance: number, latestTime?: number): boolean {
    const state = this.stateFor(video);
    if (latestTime !== undefined) state.pendingTime = latestTime;
    state.inFlight = false;
    return this.flush(video, tolerance);
  }

  private stateFor(video: SeekableVideo): SeekState {
    const existing = this.states.get(video);
    if (existing?.source === video.src) return existing;
    const state: SeekState = { source: video.src, inFlight: false, pendingTime: null };
    this.states.set(video, state);
    return state;
  }
}

/** Widen buffering without load(): reloading would discard a cached/decoded frame. */
export const prepareTimelineVideo = (
  video: SeekableVideo & { preload: string },
  queue: TimelineVideoSeekQueue,
  seconds: number,
  tolerance: number,
): void => {
  video.preload = 'auto';
  // Register the trim point even before metadata; readiness callbacks flush it later.
  queue.request(video, seconds, tolerance);
};
