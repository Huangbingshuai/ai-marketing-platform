import { describe, expect, it } from 'vitest';
import { effectTemplateMixTransitionPresentation } from './effect-template-mix-transition';

describe('effect template mix transition presentation', () => {
  it('crossfades both clips through the complete progress range', () => {
    const presentation = effectTemplateMixTransitionPresentation('叠化', 0.25);
    expect(presentation.outgoing.opacity).toBe('0.75');
    expect(presentation.incoming.opacity).toBe('0.25');
  });

  it('keeps directional transitions on two independent layers', () => {
    const presentation = effectTemplateMixTransitionPresentation('左滑', 0.5);
    expect(presentation.outgoing.transform).toContain('-50%');
    expect(presentation.incoming.transform).toContain('50%');
  });

  it('adds an overlay for flash transitions without replacing either clip', () => {
    const presentation = effectTemplateMixTransitionPresentation('闪白', 0.5);
    expect(presentation.outgoing.opacity).toBe('0.5');
    expect(presentation.incoming.opacity).toBe('0.5');
    expect(presentation.overlay?.background).toBe('#fff');
  });

  it('clamps out-of-range progress so seeking stays deterministic', () => {
    const start = effectTemplateMixTransitionPresentation('擦除', -1);
    const end = effectTemplateMixTransitionPresentation('擦除', 2);
    expect(start.incoming.clipPath).toContain('100%');
    expect(end.incoming.clipPath).toContain('0%');
  });

  it('supports the additional popular directional and shader-inspired transitions', () => {
    const right = effectTemplateMixTransitionPresentation('右滑', 0.5);
    const diamond = effectTemplateMixTransitionPresentation('菱形展开', 0.5);
    const glitch = effectTemplateMixTransitionPresentation('故障', 0.5);
    expect(right.incoming.transform).toContain('-50%');
    expect(diamond.incoming.clipPath).toContain('50%');
    expect(glitch.overlay?.mixBlendMode).toBe('screen');
  });

  it('supports the extended geometric and texture transition set', () => {
    const spread = effectTemplateMixTransitionPresentation('圆形扩散', 0.5);
    const page = effectTemplateMixTransitionPresentation('翻页', 0.5);
    const liquid = effectTemplateMixTransitionPresentation('液体扭曲', 0.5);
    const wipe = effectTemplateMixTransitionPresentation('斜向擦除', 0.5);
    expect(spread.incoming.clipPath).toContain('circle');
    expect(page.outgoing.transform).toContain('perspective');
    expect(liquid.outgoing.filter).toContain('saturate');
    expect(wipe.incoming.clipPath).toContain('polygon');
  });
});
