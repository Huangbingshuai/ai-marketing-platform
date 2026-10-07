import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({ mount: () => {}, unmount: () => {} }));
vi.mock('vue', () => ({
  ref: (value: unknown) => ({ value }),
  onMounted: (callback: () => void) => { lifecycle.mount = callback; },
  onBeforeUnmount: (callback: () => void) => { lifecycle.unmount = callback; },
}));
import { useEffectTemplateMixMediaVisibility } from './effect-template-mix-media-visibility';

describe('visible media loading boundary', () => {
  let notify: (entries: { isIntersecting: boolean }[]) => void;
  const observe = vi.fn();
  const disconnect = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class {
      observe = observe;
      disconnect = disconnect;
      constructor(callback: typeof notify) { notify = callback; }
    });
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
  it('does not request offscreen media and reacts when entering/leaving a scroll viewport', () => {
    const { host, visible } = useEffectTemplateMixMediaVisibility();
    expect(visible.value).toBe(false);
    host.value = {} as HTMLElement;
    lifecycle.mount();
    expect(observe).toHaveBeenCalledWith(host.value);
    notify([{ isIntersecting: true }]); expect(visible.value).toBe(true);
    notify([{ isIntersecting: false }]); expect(visible.value).toBe(false);
    lifecycle.unmount(); expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it('falls back to regular loading without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { visible } = useEffectTemplateMixMediaVisibility();
    expect(visible.value).toBe(true);
    lifecycle.mount(); lifecycle.unmount();
    expect(observe).not.toHaveBeenCalled();
  });
});
