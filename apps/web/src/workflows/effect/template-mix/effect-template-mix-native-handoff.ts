type NativeVideo = Pick<HTMLVideoElement, 'play' | 'pause' | 'paused'>;

/** A prepared clip is not buffering merely because it has not been played yet.
 * Deduplicate play promises and keep canceled/late attempts out of a new scope. */
export class PreparedVideoHandoff {
  private pending = new WeakMap<NativeVideo, { started: number }>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(video: NativeVideo, current: () => boolean, failed: (error?: unknown) => void): void {
    if (!video.paused || this.pending.has(video) || !current()) return;
    const attempt = { started: this.now() };
    this.pending.set(video, attempt);
    const finish = (error?: unknown): void => {
      if (this.pending.get(video) !== attempt) {
        if (!this.pending.has(video) && !current()) video.pause();
        return;
      }
      this.pending.delete(video);
      if (!current()) {
        video.pause();
        return;
      }
      if (error) failed(error);
    };
    try {
      void video.play().then(() => finish(), finish);
    } catch (error) {
      finish(error);
    }
  }

  stalled(video: NativeVideo, milliseconds = 350): boolean {
    const attempt = this.pending.get(video);
    return !!attempt && this.now() - attempt.started >= milliseconds;
  }

  /** Invalidate before another transport starts using the same media element. */
  cancel(): void {
    this.pending = new WeakMap();
  }
}
