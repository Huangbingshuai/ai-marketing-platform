type FrameVideo = {
  src: string;
  currentSrc: string;
  currentTime: number;
  readyState: number;
  seeking: boolean;
};

/** A seek event is not a paint. Keep the poster until the decoded frame has crossed a paint. */
export class TimelineFramePresentation {
  private pending = new Map<FrameVideo, { cancel: () => void }>();

  reset(): void {
    for (const request of this.pending.values()) request.cancel();
    this.pending.clear();
  }

  present(video: FrameVideo, seconds: number, tolerance: number, publish: () => void): void {
    this.pending.get(video)?.cancel();
    const source = video.src;
    let frame = 0;
    const request = { cancel: () => cancelAnimationFrame(frame) };
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
        if (ready()) publish();
        if (this.pending.get(video) === request) this.pending.delete(video);
      });
    });
  }
}
