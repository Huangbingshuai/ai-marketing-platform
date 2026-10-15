/** Coalesce discovery reads; a new scope or accepted task supersedes old discovery. */
export class PackagingBackgroundReader {
  private pending: { controller: AbortController; promise: Promise<void> } | undefined;

  read(action: (signal: AbortSignal, current: () => boolean) => Promise<void>): Promise<void> {
    if (this.pending) return this.pending.promise;
    const entry = { controller: new AbortController(), promise: Promise.resolve() };
    this.pending = entry;
    entry.promise = Promise.resolve()
      .then(() => {
        if (entry.controller.signal.aborted) return;
        return action(
          entry.controller.signal,
          () => this.pending === entry && !entry.controller.signal.aborted,
        );
      })
      .finally(() => {
        if (this.pending === entry) this.pending = undefined;
      });
    return entry.promise;
  }

  invalidate(): void {
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}
