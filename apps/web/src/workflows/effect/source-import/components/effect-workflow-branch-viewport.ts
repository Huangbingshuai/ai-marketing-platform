export const BRANCH_MIN_ZOOM = 0.4;
export const BRANCH_MAX_ZOOM = 1.4;

export function clampBranchZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(BRANCH_MAX_ZOOM, Math.max(BRANCH_MIN_ZOOM, value)) * 100) / 100;
}

export function fitBranchZoom(
  viewport: { width: number; height: number },
  canvas: { width: number; height: number },
): number {
  if (viewport.width <= 0 || viewport.height <= 0 || canvas.width <= 0 || canvas.height <= 0)
    return 1;
  return clampBranchZoom(Math.min(
    (viewport.width - 32) / canvas.width,
    (viewport.height - 32) / canvas.height,
    1,
  ));
}

// Preserve the viewport's center, not the canvas origin, when zooming in place.
export function branchZoomScroll(
  offset: number, viewportSize: number, previousZoom: number, nextZoom: number,
): number {
  if (previousZoom <= 0) return 0;
  return Math.max(0, (offset + viewportSize / 2) * nextZoom / previousZoom - viewportSize / 2);
}
