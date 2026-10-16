type PreviewMedia = Pick<HTMLMediaElement, 'currentTime' | 'paused' | 'ended'>;

/** Presentation only: sample the native media clock, never advance a synthetic clock. */
export class MaterialPreviewClock {
  private frame: number | undefined;
  private generation = 0;

  constructor(
    private readonly requestFrame: (callback: FrameRequestCallback) => number = (callback) =>
      requestAnimationFrame(callback),
    private readonly cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {}

  start(media: PreviewMedia, publish: (seconds: number) => void): void {
    this.stop();
    const generation = this.generation;
    const tick = () => {
      if (generation !== this.generation) return;
      this.frame = undefined;
      publish(Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0);
      if (generation !== this.generation || media.paused || media.ended) return;
      this.frame = this.requestFrame(tick);
    };
    tick();
  }

  stop(): void {
    this.generation += 1;
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined;
  }
}
