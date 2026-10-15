/** Serialize Run reads without losing a notification received during an older read. */
export const createEffectRunRefreshQueue = <T>(
  refresh: (request: T, isCurrent: () => boolean) => Promise<void>,
) => {
  let generation = 0;
  let active: Promise<void> | null = null;

  const request = (value: T): Promise<void> => {
    const requestedGeneration = ++generation;
    const isCurrent = (): boolean => generation === requestedGeneration;
    const next = (active ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (isCurrent()) await refresh(value, isCurrent);
      })
      .finally(() => {
        if (active === next) active = null;
      });
    active = next;
    return next;
  };

  const invalidate = (): void => {
    generation += 1;
  };
  return { request, invalidate };
};
