/** Offsets are fractions of canvas width/height, relative to its centre (Y points down). */
export type EffectVideoTransform = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  uniform: boolean;
};
export const EFFECT_VIDEO_TRANSFORM_DEFAULT: Readonly<EffectVideoTransform> = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  uniform: true,
};
export const EFFECT_CANVAS_RATIOS = [
  { label: '16:9（西瓜视频）', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '2.35:1', value: '2.35:1' },
  { label: '2:1', value: '2:1' },
  { label: '1.85:1', value: '1.85:1' },
  { label: '9:16（抖音）', value: '9:16' },
  { label: '3:4', value: '3:4' },
  { label: '5.8寸', value: '9:19.5' },
  { label: '1:1', value: '1:1' },
] as const;
export function effectCanvasAspect(ratio: unknown): number | null {
  if (typeof ratio !== 'string' || !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(ratio)) return null;
  const [w, h] = ratio.split(':').map(Number);
  const value = w! / h!;
  return w! > 0 && h! > 0 && Number.isFinite(value) && value >= 0.25 && value <= 4 ? value : null;
}
export function effectVideoTransformValid(value: unknown): value is EffectVideoTransform {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const t = value as EffectVideoTransform;
  return (
    [t.x, t.y, t.scaleX, t.scaleY, t.rotation].every(Number.isFinite) &&
    Math.abs(t.x) <= 2 &&
    Math.abs(t.y) <= 2 &&
    t.scaleX >= 0.1 &&
    t.scaleX <= 5 &&
    t.scaleY >= 0.1 &&
    t.scaleY <= 5 &&
    Math.abs(t.rotation) <= 180 &&
    typeof t.uniform === 'boolean'
  );
}
/** Mirrored by the FFmpeg worker: codec pixel rounding may differ from the nominal ratio. */
export const EFFECT_VIDEO_MATCHING_ASPECT_TOLERANCE = 0.01;
export function effectVideoCanvasFit(sourceRatio: number, canvasRatio: number) {
  const matching =
    Math.max(sourceRatio / canvasRatio, canvasRatio / sourceRatio) <=
    1 + EFFECT_VIDEO_MATCHING_ASPECT_TOLERANCE;
  return {
    aspect: matching ? canvasRatio : sourceRatio,
    mediaWidth: matching ? Math.max(1, sourceRatio / canvasRatio) : 1,
    mediaHeight: matching ? Math.max(1, canvasRatio / sourceRatio) : 1,
  };
}
/** Near-matching ratios cover/crop first; other ratios contain, then apply user transforms. */
export function effectVideoGeometry(
  sourceRatio: number,
  canvasRatio: number,
  t: EffectVideoTransform,
) {
  sourceRatio = effectVideoCanvasFit(sourceRatio, canvasRatio).aspect;
  const width = Math.min(1, sourceRatio / canvasRatio) * t.scaleX;
  const height = Math.min(1, canvasRatio / sourceRatio) * t.scaleY;
  const radians = (t.rotation * Math.PI) / 180;
  const boxWidth =
    Math.abs(Math.cos(radians)) * width + (Math.abs(Math.sin(radians)) * height) / canvasRatio;
  const boxHeight =
    Math.abs(Math.cos(radians)) * height + Math.abs(Math.sin(radians)) * width * canvasRatio;
  return { width, height, boxWidth, boxHeight };
}
/** UI-only uniform toggle and explicit identity must not mark old output stale. */
export function effectVideoTransformSnapshot(t?: EffectVideoTransform) {
  if (!t || (t.x === 0 && t.y === 0 && t.scaleX === 1 && t.scaleY === 1 && t.rotation === 0))
    return undefined;
  return { x: t.x, y: t.y, scaleX: t.scaleX, scaleY: t.scaleY, rotation: t.rotation };
}
export function effectResolvedCanvasRatio(
  variant: {
    canvasRatio?: string;
    slots: readonly { id: string }[];
    bindings: Record<string, string>;
    bindingSources?: Record<string, { ratio: string }>;
  },
  materials: readonly { id: string; ratio: string }[],
  configured?: string | null,
  fallback = '9:16',
): string {
  if (effectCanvasAspect(variant.canvasRatio) !== null) return variant.canvasRatio!;
  if (effectCanvasAspect(configured) !== null) return configured!;
  const counts = new Map<string, { count: number; ratio: string; aspect: number }>();
  for (const material of materials) {
    const aspect = effectCanvasAspect(material.ratio);
    if (aspect === null) continue;
    // Count equivalent pixel ratios together, independently of pool ordering.
    const key = aspect.toFixed(8);
    const ratio =
      EFFECT_CANVAS_RATIOS.find((item) => Math.abs(effectCanvasAspect(item.value)! - aspect) < 1e-8)
        ?.value ?? material.ratio.split(':').map(Number).join(':');
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
      if (
        ratio.length < entry.ratio.length ||
        (ratio.length === entry.ratio.length && ratio < entry.ratio)
      )
        entry.ratio = ratio;
    } else {
      counts.set(key, { count: 1, ratio, aspect });
    }
  }
  const preferred = effectCanvasAspect(fallback) ?? 9 / 16;
  const popular = [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      Number(Math.abs(b.aspect - preferred) < 1e-8) -
        Number(Math.abs(a.aspect - preferred) < 1e-8) ||
      a.aspect - b.aspect,
  )[0];
  if (popular) return popular.ratio;
  return effectCanvasAspect(fallback) !== null ? fallback : '9:16';
}
