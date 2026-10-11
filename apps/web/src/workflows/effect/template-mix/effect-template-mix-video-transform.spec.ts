import { describe, expect, it } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import toolbar from './EffectVideoTransformToolbar.vue?raw';
import menu from './EffectCanvasRatioMenu.vue?raw';
import timeline from './EffectTemplateMixTimeline.vue?raw';
import {
  EFFECT_CANVAS_RATIOS,
  EFFECT_VIDEO_TRANSFORM_DEFAULT,
  effectCanvasAspect,
  effectVideoGeometry,
} from '@ai-marketing/contracts';
describe('video transform integration', () => {
  it('crops only the near-matching baseline before explicit user transforms', () => {
    expect(page).toContain('effectVideoCanvasFit(slotSourceAspect(id), stageAspectRatio.value)');
    expect(page).toContain('...timelinePlayerStyle(slot.id), ...slotVideoContentStyle(slot.id)');
    expect(page).toContain(':style="slotVideoContentStyle(previewSlot.id)"');
    expect(page).toContain('transform-origin:center;overflow:hidden');
  });
  it('uses decoded dimensions for video, poster, transform frame and guides instead of generation ratio', () => {
    expect(page).toContain('playerMediaAspect(video.videoWidth, video.videoHeight)');
    expect(page).toContain("video.getAttribute('src') !== material.contentUrl");
    expect(page).toContain('slotSourceAspect(id), stageAspectRatio.value, t');
    expect(page).toContain("const mediaFit = slotMeasuredAspect(id) ? 'fill' : 'contain'");
    expect(page).toContain('object-fit:var(--video-fit, contain)');
    expect(page).toContain('object-fit: var(--video-fit, contain)');
    expect(page).not.toContain('effectCanvasAspect(materialForSlot(');
    expect(page).toContain('0.5 + t.x - g.width / 2');
    expect(page).toContain('0.5 + t.y - g.height / 2');
  });
  it('connects scale alignment, overview and grouped trackpad gestures without adding persistent state', () => {
    expect(page).toContain('@wheel="onVideoWheel"');
    expect(page).toContain('data-testid="video-scale-guide-x"');
    expect(page).toContain('data-testid="video-scale-guide-y"');
    expect(page).toContain('aria-label="素材位置概览"');
    expect(page).toContain('updateVideoGuides(drag.id, t)');
    expect(page).toContain('gesture.factor * Math.exp(-delta * .003)');
    expect(page).toContain('setTimeout(() => finishVideoWheelGesture(), 220)');
    expect(page).toContain('finishVideoWheelGesture(true)');
    expect(page).toContain("}, { flush: 'sync' });");
    expect(page).toContain('projectEditLocked.value || videoTrackLocked.value || videoDrag');
  });
  it('labels the canvas ratio rather than the current clip ratio', () => {
    expect(page).toContain('{{ sourceAspectLabel }} · 素材');
    expect(page).not.toContain("{{ stageMaterial?.ratio || '画幅未记录' }}");
    expect(page).toContain(
      'if (data.renderAspectRatio !== undefined) renderAspectRatio.value = data.renderAspectRatio;',
    );
  });
  it('keeps the ratio trigger text-only while preserving its accessible menu', () => {
    expect(menu).not.toContain('⌄');
    expect(menu).toContain('aria-haspopup="menu"');
    expect(menu).toContain(':aria-expanded="open"');
    expect(menu).toContain('@click="open = !open"');
  });
  const ratios = [...EFFECT_CANVAS_RATIOS.map(({ value }) => value), '7:5', '1:4', '4:1'];
  it.each(ratios)('fits matching %s source and canvas exactly without overscan', (ratio) => {
    const aspect = effectCanvasAspect(ratio)!;
    const geometry = effectVideoGeometry(aspect, aspect, EFFECT_VIDEO_TRANSFORM_DEFAULT);
    expect(geometry).toEqual({ width: 1, height: 1, boxWidth: 1, boxHeight: 1 });
  });
  it.each(ratios)('preserves contain bounds and transform geometry on a %s canvas', (ratio) => {
    const canvas = effectCanvasAspect(ratio)!;
    for (const source of ratios) {
      const aspect = effectCanvasAspect(source)!;
      const g = effectVideoGeometry(aspect, canvas, EFFECT_VIDEO_TRANSFORM_DEFAULT);
      expect(Math.max(g.width, g.height)).toBe(1);
      expect((g.width / g.height) * canvas).toBeCloseTo(aspect, 12);
      expect(g.width).toBeGreaterThan(0);
      expect(g.height).toBeGreaterThan(0);
      const moved = effectVideoGeometry(aspect, canvas, {
        ...EFFECT_VIDEO_TRANSFORM_DEFAULT,
        x: 0.2,
        y: -0.1,
      });
      expect(moved).toEqual(g);
      const scaled = effectVideoGeometry(aspect, canvas, {
        ...EFFECT_VIDEO_TRANSFORM_DEFAULT,
        scaleX: 1.2,
        scaleY: 1.2,
      });
      expect(scaled.width).toBeCloseTo(g.width * 1.2, 12);
      expect(scaled.height).toBeCloseTo(g.height * 1.2, 12);
      const rotated = effectVideoGeometry(aspect, canvas, {
        ...EFFECT_VIDEO_TRANSFORM_DEFAULT,
        rotation: 90,
      });
      expect(rotated.boxWidth).toBeCloseTo(g.height / canvas, 12);
      expect(rotated.boxHeight).toBeCloseTo(g.width * canvas, 12);
    }
  });
  it('places an untransformed full-canvas image flush without rounded clipping or a decorative rim', () => {
    expect(page).toContain("left: '0', top: '0', width: '100%', height: '100%', transform: 'none'");
    const stage = page.slice(
      page.indexOf('\n.stage {'),
      page.indexOf('\n.player-transition-frame {'),
    );
    expect(stage).toContain('border-radius: 0;');
    expect(stage).toContain('box-shadow: none;');
  });
  it('does not dismiss video controls when the other tracks emit an empty selection', () => {
    expect(page).toContain('if (clipId) selectedVideoTransformIds.value = [];');
    expect(page).toContain('if (captionIds.length) selectedVideoTransformIds.value = [];');
    expect(page).toContain('if (clipIds.length) selectedVideoTransformIds.value = [];');
    expect(timeline).toContain('setSelection([...selectedClipIds.value]);');
  });
  it('uses variant-owned geometry independently of preview zoom and audition', () => {
    expect(page).toContain('variant.videoTransforms =');
    expect(page).toContain('effectVideoGeometry(');
    expect(page).toContain('selectedVariant.value ?? { slots: [], bindings: {} }');
    expect(page).not.toContain("renderAspectRatio.value !== 'adaptive'");
    expect(page).toContain('transformFrameVisible');
    expect(page).toContain('!auditionMaterial');
    expect(page).toContain('variant.videoTransforms[right.id] = cloneMix');
    expect(page).toContain('container-type: size');
    expect(page).toContain('100cqh * var(--stage-aspect)');
    expect(page).toContain('100cqw / var(--stage-aspect)');
    expect(page).not.toContain('auditionMaterial.value?.ratio.trim()');
    expect(page).not.toContain(":disabled=\"renderAspectRatio !== 'adaptive'");
    expect(menu).toContain('默认画幅');
  });
  it('groups a gesture and guards pointer cancellation and cross-scope changes', () => {
    expect(page).toContain('currentWorkspaceScope.value !== drag.scope');
    expect(page).toContain('variant.id !== drag.variantId');
    expect(page).toContain("event.type === 'pointercancel'");
    expect(page).toContain('captionGuideX.value = x.guide');
    expect(page).toContain('captionGuideY.value = y.guide');
    expect(page).toContain(
      'rememberTimelineEdit(); clearTimeout(saveTimer); groupedTimelineMove = true',
    );
  });
  it('places the horizontal contextual toolbar between the panes and timeline without keyframes', () => {
    const at = page.indexOf('<EffectVideoTransformToolbar');
    expect(at).toBeGreaterThan(page.indexOf('class="player-panel"'));
    expect(at).toBeLessThan(page.indexOf('<EffectTemplateMixTimeline'));
    for (const text of [
      '缩放',
      '等比缩放',
      '旋转',
      '左对齐',
      '右对齐',
      '顶对齐',
      '底对齐',
      '水平等距分布',
      '垂直等距分布',
    ])
      expect(toolbar).toContain(text);
    expect(toolbar).not.toContain('关键帧');
    expect(toolbar).toMatch(/overflow-x:\s*auto/);
    expect(menu).toContain('@keydown.esc.stop');
    expect(menu).toContain('自定义');
  });
});
