import { describe, expect, it } from 'vitest';
import treeSource from './EffectWorkflowBranchTree.vue?raw';
import { branchZoomScroll, clampBranchZoom, fitBranchZoom } from './effect-workflow-branch-viewport';

describe('branch tree display-only viewport', () => {
  it('bounds zoom and rejects non-finite input', () => {
    expect(clampBranchZoom(0.01)).toBe(0.4);
    expect(clampBranchZoom(5)).toBe(1.4);
    expect(clampBranchZoom(NaN)).toBe(1);
    expect(clampBranchZoom(0.876)).toBe(0.88);
  });
  it('fits both dimensions without enlarging a small tree', () => {
    expect(fitBranchZoom({ width: 1032, height: 832 }, { width: 1600, height: 1000 })).toBe(0.63);
    expect(fitBranchZoom({ width: 1032, height: 532 }, { width: 800, height: 1000 })).toBe(0.5);
    expect(fitBranchZoom({ width: 2000, height: 1000 }, { width: 400, height: 500 })).toBe(1);
    expect(fitBranchZoom({ width: 0, height: 500 }, { width: 400, height: 500 })).toBe(1);
  });
  it('preserves the viewed center and clamps scrolling at the origin', () => {
    expect(branchZoomScroll(200, 800, 1, 1.2)).toBe(320);
    expect(branchZoomScroll(100, 600, 1, 0.5)).toBe(0);
    expect(branchZoomScroll(300, 800, 0, 1)).toBe(0);
  });
  it('provides accessible view controls independent of branch switching', () => {
    expect(treeSource).toContain('aria-label="缩小版本树"');
    expect(treeSource).toContain('aria-label="放大版本树"');
    expect(treeSource).toContain('@click="fitTree"');
    expect(treeSource).toContain('@click="locateCurrent"');
    expect(treeSource).toContain('data-branch-key');
    expect(treeSource).toContain('zoom: treeZoom');
    expect(treeSource).toContain('Math.max(0.8, fitBranchZoom(');
    expect(treeSource).toContain('right.stageIndex - left.stageIndex');
    expect(treeSource).toContain('card.focus({ preventScroll: true })');
    expect(treeSource.split('.branch-node:hover:not(:disabled) {')[1]?.split('}')[0])
      .not.toContain('border-color');
  });
});
