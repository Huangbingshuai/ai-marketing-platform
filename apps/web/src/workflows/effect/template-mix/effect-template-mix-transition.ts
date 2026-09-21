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
    case '右滑':
      return {
        outgoing: { opacity: '1', transform: `translate3d(${progress * 100}%, 0, 0)` },
        incoming: {
          opacity: '1',
          transform: `translate3d(${(1 - progress) * -100}%, 0, 0)`,
        },
      };
    case '下推':
      return {
        outgoing: { opacity: '1', transform: `translate3d(0, ${progress * 100}%, 0)` },
        incoming: {
          opacity: '1',
          transform: `translate3d(0, ${(1 - progress) * -100}%, 0)`,
        },
      };
    case '旋转':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `perspective(900px) rotate(${progress * -180}deg) scale(${1 - progress * 0.3})`,
          transformOrigin: '50% 50%',
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `perspective(900px) rotate(${(1 - progress) * 180}deg) scale(${0.7 + progress * 0.3})`,
          transformOrigin: '50% 50%',
        },
      };
    case '百叶窗':
      return {
        outgoing: { opacity: outgoingOpacity },
        incoming: {
          opacity: '1',
          clipPath: `inset(0 ${Math.max(0, (1 - progress) * 100)}% 0 0)`,
        },
        overlay: {
          opacity: String((1 - progress) * 0.28),
          background:
            'repeating-linear-gradient(90deg, #0b1724 0 2px, transparent 2px 14px)',
        },
      };
    case '菱形展开': {
      const radius = Math.max(0.1, progress * 72);
      return {
        outgoing: { opacity: '1' },
        incoming: {
          opacity: '1',
          clipPath: `polygon(50% ${50 - radius}%, ${50 + radius}% 50%, 50% ${50 + radius}%, ${50 - radius}% 50%)`,
        },
      };
    }
    case '像素化':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          filter: `blur(${progress * 5}px) contrast(${1 + progress * 0.35})`,
        },
        incoming: {
          opacity: incomingOpacity,
          filter: `blur(${(1 - progress) * 8}px) contrast(${1 + (1 - progress) * 0.35})`,
        },
        overlay: {
          opacity: String(Math.sin(progress * Math.PI) * 0.18),
          background:
            'repeating-linear-gradient(0deg, transparent 0 3px, #fff 3px 4px), repeating-linear-gradient(90deg, transparent 0 3px, #fff 3px 4px)',
          mixBlendMode: 'screen',
        },
      };
    case '故障': {
      const jitter = Math.sin(progress * Math.PI * 8) * (1 - progress) * 2.5;
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `translate3d(${jitter}%, 0, 0) skewX(${jitter * 0.35}deg)`,
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `translate3d(${-jitter}%, 0, 0) skewX(${-jitter * 0.35}deg)`,
        },
        overlay: {
          opacity: String(Math.sin(progress * Math.PI) * 0.36),
          background:
            'repeating-linear-gradient(0deg, #f43f5e 0 2px, transparent 2px 8px, #22d3ee 8px 10px, transparent 10px 16px)',
          mixBlendMode: 'screen',
        },
      };
    }
    case '色差':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `translate3d(${-progress * 3}%, 0, 0)`,
          filter: `hue-rotate(${progress * -28}deg) saturate(${1 + progress * 1.2})`,
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `translate3d(${(1 - progress) * 3}%, 0, 0)`,
          filter: `hue-rotate(${(1 - progress) * 28}deg) saturate(${1 + (1 - progress) * 1.2})`,
        },
        overlay: {
          opacity: String(Math.sin(progress * Math.PI) * 0.22),
          background: 'linear-gradient(90deg, #ef4444, transparent 42%, #22d3ee)',
          mixBlendMode: 'screen',
        },
      };
    case '波纹':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `scale(${1 + progress * 0.12})`,
          filter: `blur(${progress * 3}px)`,
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `scale(${0.82 + progress * 0.18})`,
          filter: `blur(${(1 - progress) * 3}px)`,
        },
        overlay: {
          opacity: String(Math.sin(progress * Math.PI) * 0.32),
          background: `radial-gradient(circle at 50% 50%, transparent ${progress * 62}%, #e0f2fe ${Math.min(100, progress * 62 + 3)}%, transparent ${Math.min(100, progress * 62 + 6)}%)`,
          mixBlendMode: 'screen',
        },
      };
    case '闪黑':
      return {
        outgoing: { opacity: outgoingOpacity },
        incoming: { opacity: incomingOpacity },
        overlay: {
          opacity: String(Math.sin(progress * Math.PI) * 0.92),
          background: '#05070b',
        },
      };
    case '缩小':
      return {
        outgoing: {
          opacity: outgoingOpacity,
          transform: `scale(${1 - progress * 0.28})`,
          filter: `blur(${progress * 2}px)`,
        },
        incoming: {
          opacity: incomingOpacity,
          transform: `scale(${1.18 - progress * 0.18})`,
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
