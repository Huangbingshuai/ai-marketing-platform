/** UI-only alignment: native video compositors round fractional edges independently. */
export function playerPixelFloor(value: number, ratio: number): number {
  return Math.floor(value * ratio + 1e-7) / ratio;
}

export function attachPlayerPixelGrid(stage: HTMLElement): () => void {
  const parent = stage.parentElement;
  let frame: number | undefined;
  let disposed = false;
  const schedule = () => {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      attributes.disconnect();
      // Re-read the natural container-query fit instead of keeping the last fixed size.
      stage.style.removeProperty('width');
      stage.style.removeProperty('height');
      stage.style.removeProperty('translate');
      const transform = getComputedStyle(stage).transform;
      const matrix = transform === 'none' ? null : new DOMMatrixReadOnly(transform);
      const unzoomed = !matrix || (Math.abs(matrix.a - 1) < 1e-6 && Math.abs(matrix.d - 1) < 1e-6);
      const bounds = stage.getBoundingClientRect();
      if (unzoomed && bounds.width > 0 && bounds.height > 0) {
        const ratio =
          Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
        stage.style.width = `${playerPixelFloor(bounds.width, ratio)}px`;
        stage.style.height = `${playerPixelFloor(bounds.height, ratio)}px`;
        const fitted = stage.getBoundingClientRect();
        const x = Math.round(fitted.left * ratio) / ratio - fitted.left;
        const y = Math.round(fitted.top * ratio) / ratio - fitted.top;
        stage.style.translate = `${x}px ${y}px`;
      }
      if (!disposed)
        attributes.observe(stage, { attributes: true, attributeFilter: ['style', 'class'] });
    });
  };
  const attributes = new MutationObserver(schedule);
  const size = new ResizeObserver(schedule);
  if (parent) size.observe(parent);
  attributes.observe(stage, { attributes: true, attributeFilter: ['style', 'class'] });
  window.addEventListener('resize', schedule);
  stage.addEventListener('transitionend', schedule);
  schedule();
  return () => {
    disposed = true;
    attributes.disconnect();
    size.disconnect();
    window.removeEventListener('resize', schedule);
    stage.removeEventListener('transitionend', schedule);
    if (frame !== undefined) cancelAnimationFrame(frame);
    stage.style.removeProperty('width');
    stage.style.removeProperty('height');
    stage.style.removeProperty('translate');
  };
}
