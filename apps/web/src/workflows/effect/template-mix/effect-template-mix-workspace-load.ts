/** Only an actual read of a different workspace is a branch switch, not a task publication wait. */
export const isMixWorkspaceSwitching = (
  requestedScope: string | null,
  installedScope: string,
  currentScope: string,
): boolean => requestedScope === currentScope && installedScope !== currentScope;

/** Bound a read even if the underlying request does not settle after cancellation. */
export const readMixWorkspaceWithDeadline = async <T>(
  read: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
  timeoutMs = 30_000,
): Promise<T> => {
  if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('请求已取消', 'AbortError'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      reject(new Error('混剪工作区加载超时，请重试；后台任务仍会继续，不会重复生成'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
};
