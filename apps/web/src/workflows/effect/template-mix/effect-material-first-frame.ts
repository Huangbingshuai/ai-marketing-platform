type PreviewVideo = Pick<
  HTMLVideoElement,
  | 'src'
  | 'currentSrc'
  | 'readyState'
  | 'seeking'
  | 'videoWidth'
  | 'videoHeight'
  | 'addEventListener'
  | 'removeEventListener'
> &
  Partial<Pick<HTMLVideoElement, 'requestVideoFrameCallback' | 'cancelVideoFrameCallback'>>;

/** Keep the material cover until this decoder has actually presented its first frame. */
export class MaterialFirstFrame {
  private cancel: (() => void) | undefined;

  reset(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  wait(video: PreviewVideo, publish: () => void): void {
    this.reset();
    const source = video.src;
    let active = true;
    let paint: number | undefined;
    let decoded: number | undefined;
    const events = ['loadeddata', 'canplay', 'playing', 'seeked'];
    const ready = () =>
      active &&
      video.src === source &&
      video.currentSrc === source &&
      video.readyState >= 2 &&
      !video.seeking &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;
    const cleanup = () => {
      active = false;
      if (paint !== undefined) cancelAnimationFrame(paint);
      if (decoded !== undefined) video.cancelVideoFrameCallback?.(decoded);
      for (const event of events) video.removeEventListener(event, schedule);
    };
    const reveal = () => {
      if (!ready()) return;
      cleanup();
      this.cancel = undefined;
      publish();
    };
    const schedule = () => {
      if (!active || paint !== undefined || decoded !== undefined) return;
      if (video.requestVideoFrameCallback) {
        decoded = video.requestVideoFrameCallback(() => {
          decoded = undefined;
          reveal();
          if (active) schedule();
        });
      } else if (ready()) {
        // loadeddata alone can precede the compositor's paint (also when paused).
        paint = requestAnimationFrame(() => {
          paint = requestAnimationFrame(() => {
            paint = undefined;
            reveal();
          });
        });
      }
    };
    this.cancel = cleanup;
    for (const event of events) video.addEventListener(event, schedule);
    schedule();
  }
}
