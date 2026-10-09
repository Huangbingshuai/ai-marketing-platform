import { effectVideoGeometry, type EffectVideoTransform } from '@ai-marketing/contracts';

/** Alignment is measured in screen pixels, independently of canvas/output resolution. */
export function videoTransformGuides(
  transform: EffectVideoTransform,
  sourceAspect: number,
  canvasAspect: number,
  bounds: { width: number; height: number },
) {
  const geometry = effectVideoGeometry(sourceAspect, canvasAspect, transform);
  const near = (value: number, target: number, pixels: number) =>
    pixels > 0 && Math.abs(value - target) * pixels <= 6;
  const x = [
    { edge: transform.x, target: 0, guide: 0.5 },
    { edge: 0.5 + transform.x - geometry.boxWidth / 2, target: 0, guide: 0 },
    { edge: 0.5 + transform.x + geometry.boxWidth / 2, target: 1, guide: 1 },
  ]
    .filter((item) => near(item.edge, item.target, bounds.width))
    .map((item) => item.guide);
  const y = [
    { edge: transform.y, target: 0, guide: 0.5 },
    { edge: 0.5 + transform.y - geometry.boxHeight / 2, target: 0, guide: 1 },
    { edge: 0.5 + transform.y + geometry.boxHeight / 2, target: 1, guide: 0 },
  ]
    .filter((item) => near(item.edge, item.target, bounds.height))
    .map((item) => item.guide);
  return { x, y };
}

/** Uniform change keeps the current X/Y proportion, even after a non-uniform edit. */
export function scaleVideoTransform(
  transform: EffectVideoTransform,
  factor: number,
  sourceAspect: number,
  canvasAspect: number,
  bounds: { width: number; height: number },
  snap = true,
): EffectVideoTransform {
  if (!Number.isFinite(factor) || factor <= 0) return { ...transform };
  const minimum = 0.1 / Math.min(transform.scaleX, transform.scaleY);
  const maximum = 5 / Math.max(transform.scaleX, transform.scaleY);
  let safeFactor = Math.max(minimum, Math.min(maximum, factor));
  const geometry = effectVideoGeometry(sourceAspect, canvasAspect, transform);
  if (snap) {
    const candidates = [
      {
        factor: (1 + 2 * transform.x) / geometry.boxWidth,
        pixels: (bounds.width * geometry.boxWidth) / 2,
      },
      {
        factor: (1 - 2 * transform.x) / geometry.boxWidth,
        pixels: (bounds.width * geometry.boxWidth) / 2,
      },
      {
        factor: (1 + 2 * transform.y) / geometry.boxHeight,
        pixels: (bounds.height * geometry.boxHeight) / 2,
      },
      {
        factor: (1 - 2 * transform.y) / geometry.boxHeight,
        pixels: (bounds.height * geometry.boxHeight) / 2,
      },
    ]
      .filter(
        (item) =>
          item.factor >= minimum &&
          item.factor <= maximum &&
          item.pixels > 0 &&
          Math.abs(item.factor - safeFactor) * item.pixels <= 6,
      )
      .sort((a, b) => Math.abs(a.factor - safeFactor) - Math.abs(b.factor - safeFactor));
    if (candidates[0]) safeFactor = candidates[0].factor;
  }
  return {
    ...transform,
    scaleX: transform.scaleX * safeFactor,
    scaleY: transform.scaleY * safeFactor,
  };
}

export function videoWheelDelta(delta: number, mode: number, height: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.max(-240, Math.min(240, delta * (mode === 1 ? 16 : mode === 2 ? height : 1)));
}

/** Fit both the canvas and the material bounds in the small overview without clipping. */
export function videoPositionOverview(
  transform: EffectVideoTransform,
  sourceAspect: number,
  canvasAspect: number,
) {
  const g = effectVideoGeometry(sourceAspect, canvasAspect, transform);
  const left = Math.min(0, 0.5 + transform.x - g.boxWidth / 2);
  const top = Math.min(0, 0.5 + transform.y - g.boxHeight / 2);
  const right = Math.max(1, 0.5 + transform.x + g.boxWidth / 2);
  const bottom = Math.max(1, 0.5 + transform.y + g.boxHeight / 2);
  const scale = Math.min(76 / ((right - left) * canvasAspect), 52 / (bottom - top));
  const x = (80 - (right - left) * canvasAspect * scale) / 2 - left * canvasAspect * scale;
  const y = (56 - (bottom - top) * scale) / 2 - top * scale;
  return {
    canvas: { x, y, width: canvasAspect * scale, height: scale },
    material: {
      x: x + (0.5 + transform.x - g.width / 2) * canvasAspect * scale,
      y: y + (0.5 + transform.y - g.height / 2) * scale,
      width: g.width * canvasAspect * scale,
      height: g.height * scale,
    },
    centre: {
      x: x + (0.5 + transform.x) * canvasAspect * scale,
      y: y + (0.5 + transform.y) * scale,
    },
  };
}
