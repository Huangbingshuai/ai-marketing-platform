// An old request must not sign out a session established after that request started.
let generation = 0;
export const authGeneration = (): number => generation;
export const advanceAuthGeneration = (): void => {
  generation++;
};

// No dependency on UI state: shared HTTP code also runs in workers and unit tests.
export const notifyAuthRequired = (code: unknown, requestGeneration: number): void => {
  if (code === 'AUTH_REQUIRED' && requestGeneration === generation && typeof window !== 'undefined')
    window.dispatchEvent(new Event('richi:auth-required'));
};
