import type { EffectTemplateMixTransition } from '@ai-marketing/contracts';

export type TransitionPresentation = {
  outgoing: Record<string, string>;
  incoming: Record<string, string>;
  overlay?: Record<string, string>;
};

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Builds the two-layer presentation used by the editor preview. The outgoing
 * and incoming clips are intentionally independent so a seek or a paused
 * frame renders the same transition as playback.
 */
export const effectTemplateMixTransitionPresentation = (
  transition: EffectTemplateMixTransition,
  rawProgress: number,
): TransitionPresentation => {
  const progress = clamp(rawProgress);
  const incomingOpacity = String(progress);
  const outgoingOpacity = String(1 - progress);
  const crossfade = {
    outgoing: { opacity: outgoingOpacity },
    incoming: { opacity: incomingOpacity },
  };

  switch (transition) {
    case '推镜':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `scale(${1 + progress * 0.08}) translate3d(${-progress * 12}%, 0, 0)`,
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `translate3d(${(1 - progress) * 100}%, 0, 0)`,
        },
      };
    case '左滑':
      return {
        outgoing: { opacity: '1', transform: `translate3d(${-progress * 100}%, 0, 0)` },
        incoming: {
          opacity: '1',
          transform: `translate3d(${(1 - progress) * 100}%, 0, 0)`,
        },
      };
    case '上推':
      return {
        outgoing: { opacity: '1', transform: `translate3d(0, ${-progress * 100}%, 0)` },
        incoming: {
          opacity: '1',
          transform: `translate3d(0, ${(1 - progress) * 100}%, 0)`,
        },
      };
    case '闪白':
      return {
        outgoing: { opacity: outgoingOpacity },
        incoming: { opacity: incomingOpacity },
        overlay: {
          opacity: String(Math.sin(progress * Math.PI) * 0.92),
          background: '#fff',
        },
      };
    case '缩放':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `scale(${1 + progress * 0.22})`,
          filter: `blur(${progress * 1.5}px)`,
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `scale(${0.78 + progress * 0.22})`,
        },
      };
    case '擦除':
      return {
        outgoing: { opacity: '1' },
        incoming: {
          opacity: '1',
          clipPath: `inset(0 ${Math.max(0, (1 - progress) * 100)}% 0 0)`,
        },
      };
    case '翻转':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `perspective(900px) rotateY(${-progress * 88}deg)`,
          backfaceVisibility: 'hidden',
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `perspective(900px) rotateY(${(1 - progress) * 88}deg)`,
          backfaceVisibility: 'hidden',
        },
      };
    case '圆形展开':
      return {
        outgoing: { opacity: '1' },
        incoming: {
          opacity: '1',
          clipPath: `circle(${Math.max(0.1, progress * 72)}% at 50% 50%)`,
        },
      };
    case '模糊溶解':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          filter: `blur(${progress * 9}px)`,
        },
        incoming: {
          opacity: incomingOpacity,
          filter: `blur(${(1 - progress) * 9}px)`,
        },
      };
    case '叠化':
      return crossfade;
    case '硬切':
      return {
        outgoing: { opacity: '0' },
        incoming: { opacity: '1' },
      };
    default:
      return crossfade;
  }
};
