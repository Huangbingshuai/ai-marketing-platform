/** Read-only hydration is abortable on leave; actual writes and Run handoffs are not. */
export const flushEffectNodeNavigation = async (
  synchronization: Promise<void> | null,
  isWriting: () => boolean,
): Promise<boolean> => {
  await synchronization;
  return !isWriting();
};

/** A parent context install is not complete until its node data is ready too. */
export const completeEffectNodeHandoff = async (
  installContext: () => Promise<void>,
  latestNodeRead: () => Promise<void> | null,
): Promise<void> => {
  await installContext();
  let pending: Promise<void> | null;
  do {
    pending = latestNodeRead();
    await pending;
    // A replacement read may have aborted the previous one. Wait for the
    // replacement rather than publishing a half-loaded set of controls.
  } while (pending !== latestNodeRead());
};
