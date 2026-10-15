type FrameVideo = {
  src: string;
  currentSrc: string;
  currentTime: number;
  readyState: number;
  seeking: boolean;
};

/** A seek event is not a paint. Keep the poster until the decoded frame has crossed a paint. */
export class TimelineFramePresentation {
  private pending = new Map<FrameVideo, {
    source: string;
    seconds: number;
    tolerance: number;
    publish: () => void;
    cancel: () => void;
  }>();

  reset(): void {
    for (const request of this.pending.values()) request.cancel();
    this.pending.clear();
  }

  /** A running native clock cannot match a frozen seek time across two animation frames. */
  presentPlayback(video: FrameVideo, publish: () => void): boolean {
    if (video.currentSrc !== video.src || video.readyState < 2 || video.seeking) return false;
    this.pending.get(video)?.cancel();
    this.pending.delete(video);
    publish();
    return true;
  }

  present(video: FrameVideo, seconds: number, tolerance: number, publish: () => void): void {
    // loadeddata/canplay/seeked can all report the same decoded target before paint.
    // Restarting the two-RAF gate on every report can starve its publication.
    const existing = this.pending.get(video);
    if (existing?.source === video.src && existing.seconds === seconds && existing.tolerance === tolerance) {
      existing.publish = publish;
      return;
    }
    this.pending.get(video)?.cancel();
    const source = video.src;
    let frame = 0;
    const request = { source, seconds, tolerance, publish, cancel: () => cancelAnimationFrame(frame) };
    const ready = () =>
      this.pending.get(video) === request &&
      video.src === source &&
      video.currentSrc === source &&
      video.readyState >= 2 &&
      !video.seeking &&
      Math.abs(video.currentTime - seconds) <= tolerance;
    this.pending.set(video, request);
    frame = requestAnimationFrame(() => {
      // The first RAF is before paint; the second permits the new decoded frame to be drawn.
      frame = requestAnimationFrame(() => {
        if (ready()) request.publish();
        if (this.pending.get(video) === request) this.pending.delete(video);
      });
    });
  }
}
