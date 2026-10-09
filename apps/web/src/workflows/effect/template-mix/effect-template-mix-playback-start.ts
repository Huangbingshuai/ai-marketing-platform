/** Hold the transport at its requested time until the selected frame is decoded.
 * Cancellation belongs to the editor scope; a late decoder must not resume it.
 */
export const waitForPlaybackFrame = (
  ready: () => boolean,
  current: () => boolean,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  now: () => number = () => performance.now(),
): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const started = now();
    const check = () => {
      if (!current()) {
        resolve(false);
        return;
      }
      if (ready()) {
        resolve(true);
        return;
      }
      if (now() - started >= 15_000) {
        reject(new Error('视频预览解码超时'));
        return;
      }
      schedule(check);
    };
    check();
  });

/** Some decoders stop delivering media time without a waiting event. */
export class NativePlaybackProgress {
  private key: unknown;
  private seconds = 0;
  private advancedAt = 0;
  private reported = false;

  reset(): void {
    this.key = undefined;
  }

  stalled(key: unknown, seconds: number, now: number, running: boolean): boolean {
    if (!running || this.key !== key || Math.abs(seconds - this.seconds) > 0.001) {
      this.key = running ? key : undefined;
      this.seconds = seconds;
      this.advancedAt = now;
      this.reported = false;
      return false;
    }
    if (this.reported || now - this.advancedAt < 350) return false;
    this.reported = true;
    return true;
  }
}
