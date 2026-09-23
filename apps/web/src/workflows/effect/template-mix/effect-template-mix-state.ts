import type {
  EffectTemplateMixPurpose,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixTransition,
  EffectTemplateMixWorkspace,
  EffectTemplateMixTemplateEntry,
} from '@ai-marketing/contracts';
import { EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION } from '@ai-marketing/contracts';
export type * from '@ai-marketing/contracts';
export { EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION } from '@ai-marketing/contracts';

export const EFFECT_TEMPLATE_MIX_ROLE_LABELS: Record<EffectTemplateMixRole, string> = {
  END: '片尾转化',
  HOOK: '片头钩子',
  PAIN_POINT: '痛点唤醒',
  PRODUCT: '产品展示',
  SELLING_POINT: '卖点讲解',
  TRANSFORMATION: '效果呈现',
};
export const EFFECT_TEMPLATE_MIX_PURPOSE_LABELS: Record<EffectTemplateMixPurpose, string> = {
  EFFECT: '效果',
  END_CONVERSION: '结尾转化',
  HOOK: '钩子',
  PRODUCT_DISPLAY: '产品展示',
};
export const EFFECT_TEMPLATE_MIX_TRANSITIONS: readonly EffectTemplateMixTransition[] = [
  '硬切',
  '叠化',
  '推镜',
  '闪白',
  '缩放',
  '左滑',
  '上推',
  '擦除',
  '翻转',
  '圆形展开',
  '模糊溶解',
  '右滑',
  '下推',
  '旋转',
  '百叶窗',
  '菱形展开',
  '像素化',
  '故障',
  '色差',
  '波纹',
  '闪黑',
  '缩小',
  '圆形扩散',
  '线性擦除',
  '四角汇聚',
  '分割',
  '镜像',
  '翻页',
  '立方体',
  '放大模糊',
  '彩色闪光',
  '噪点溶解',
  '液体扭曲',
  '斜向擦除',
];
export const EFFECT_TEMPLATE_MIX_TRANSITION_LIBRARY = [
  {
    id: '叠化',
    label: '叠化',
    category: '热门',
    description: '柔和叠加两个片段',
    previewClass: 'is-dissolve',
  },
  {
    id: '推镜',
    label: '推镜 II',
    category: '热门',
    description: '镜头推进衔接',
    previewClass: 'is-push',
  },
  {
    id: '闪白',
    label: '闪白',
    category: '热门',
    description: '高亮闪白切换',
    previewClass: 'is-flash',
  },
  {
    id: '缩放',
    label: '缩放',
    category: '动感',
    description: '快速缩放转场',
    previewClass: 'is-zoom',
  },
  {
    id: '左滑',
    label: '左滑',
    category: '热门',
    description: '画面向左滑动衔接',
    previewClass: 'is-slide-left',
  },
  {
    id: '上推',
    label: '上推',
    category: '热门',
    description: '上下推移切换',
    previewClass: 'is-slide-up',
  },
  {
    id: '擦除',
    label: '擦除',
    category: '热门',
    description: '方向擦除进入下一幕',
    previewClass: 'is-wipe',
  },
  {
    id: '圆形展开',
    label: '圆形展开',
    category: '热门',
    description: '圆形遮罩展开画面',
    previewClass: 'is-circle',
  },
  {
    id: '翻转',
    label: '翻转',
    category: '动感',
    description: '立体翻转进入下一幕',
    previewClass: 'is-flip',
  },
  {
    id: '模糊溶解',
    label: '模糊溶解',
    category: '动感',
    description: '柔和模糊叠化',
    previewClass: 'is-blur',
  },
  {
    id: '右滑',
    label: '右滑',
    category: '热门',
    description: '画面向右滑动衔接',
    previewClass: 'is-slide-right',
  },
  {
    id: '下推',
    label: '下推',
    category: '热门',
    description: '画面向下推移切换',
    previewClass: 'is-slide-down',
  },
  {
    id: '旋转',
    label: '旋转',
    category: '热门',
    description: '旋转缩放进入下一幕',
    previewClass: 'is-rotate',
  },
  {
    id: '百叶窗',
    label: '百叶窗',
    category: '热门',
    description: '条带交错展开画面',
    previewClass: 'is-blinds',
  },
  {
    id: '菱形展开',
    label: '菱形展开',
    category: '热门',
    description: '菱形遮罩展开画面',
    previewClass: 'is-diamond',
  },
  {
    id: '像素化',
    label: '像素化',
    category: '热门',
    description: '像素模糊切换',
    previewClass: 'is-pixel',
  },
  {
    id: '故障',
    label: '故障',
    category: '热门',
    description: '数字故障闪切',
    previewClass: 'is-glitch',
  },
  {
    id: '色差',
    label: '色差',
    category: '热门',
    description: 'RGB 色彩分离切换',
    previewClass: 'is-chromatic',
  },
  {
    id: '波纹',
    label: '波纹',
    category: '热门',
    description: '波纹扩散衔接',
    previewClass: 'is-ripple',
  },
  {
    id: '闪黑',
    label: '闪黑',
    category: '热门',
    description: '黑场闪切',
    previewClass: 'is-black-flash',
  },
  {
    id: '缩小',
    label: '缩小',
    category: '热门',
    description: '缩小淡出进入下一幕',
    previewClass: 'is-shrink',
  },
  {
    id: '圆形扩散',
    label: '圆形扩散',
    category: '热门',
    description: '圆形光圈扩散切换',
    previewClass: 'is-circle-spread',
  },
  {
    id: '线性擦除',
    label: '线性擦除',
    category: '热门',
    description: '水平线性擦除画面',
    previewClass: 'is-linear-wipe',
  },
  {
    id: '四角汇聚',
    label: '四角汇聚',
    category: '热门',
    description: '从中心向四角展开',
    previewClass: 'is-four-corners',
  },
  {
    id: '分割',
    label: '分割',
    category: '热门',
    description: '画面分割衔接下一幕',
    previewClass: 'is-split',
  },
  {
    id: '镜像',
    label: '镜像',
    category: '热门',
    description: '镜像翻转切换',
    previewClass: 'is-mirror',
  },
  {
    id: '翻页',
    label: '翻页',
    category: '热门',
    description: '像翻页一样切换画面',
    previewClass: 'is-page-turn',
  },
  {
    id: '立方体',
    label: '立方体',
    category: '热门',
    description: '立方体旋转切换',
    previewClass: 'is-cube',
  },
  {
    id: '放大模糊',
    label: '放大模糊',
    category: '热门',
    description: '放大并模糊淡入',
    previewClass: 'is-zoom-blur',
  },
  {
    id: '彩色闪光',
    label: '彩色闪光',
    category: '热门',
    description: '彩色光线闪过画面',
    previewClass: 'is-color-flash',
  },
  {
    id: '噪点溶解',
    label: '噪点溶解',
    category: '热门',
    description: '颗粒噪点溶解切换',
    previewClass: 'is-noise-dissolve',
  },
  {
    id: '液体扭曲',
    label: '液体扭曲',
    category: '热门',
    description: '柔和扭曲过渡画面',
    previewClass: 'is-liquid',
  },
  {
    id: '斜向擦除',
    label: '斜向擦除',
    category: '热门',
    description: '斜向光幕擦除画面',
    previewClass: 'is-diagonal-wipe',
  },
  {
    id: '硬切',
    label: '硬切',
    category: '基础',
    description: '无过渡直接切换',
    previewClass: 'is-cut',
  },
] as const satisfies readonly {
  id: EffectTemplateMixTransition;
  label: string;
  category: string;
  description: string;
  previewClass: string;
}[];
export const effectTemplateMixTransitionDuration = (
  slot: EffectTemplateMixSlot,
  previousSlot?: EffectTemplateMixSlot,
): number => {
  if (slot.transition === '硬切' || !previousSlot) return 0;
  const max = Math.min(5, slot.duration, previousSlot?.duration ?? slot.duration);
  const configured = Number(slot.transitionDuration);
  const value =
    configured > 0 ? configured : EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION;
  return Math.max(0.1, Math.min(max, value));
};
export const cloneMix = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const createEffectTemplateMixEntry = (name: string): EffectTemplateMixTemplateEntry => {
  const roles: EffectTemplateMixRole[] = [
    'HOOK',
    'PAIN_POINT',
    'PRODUCT',
    'SELLING_POINT',
    'TRANSFORMATION',
    'END',
  ];
  const purposes: EffectTemplateMixPurpose[] = [
    'HOOK',
    'EFFECT',
    'PRODUCT_DISPLAY',
    'PRODUCT_DISPLAY',
    'EFFECT',
    'END_CONVERSION',
  ];
  return {
    id: crypto.randomUUID(),
    workspace: {
      editVersion: 1,
      materials: [],
      variants: [],
      template: {
        name,
        editVersion: 1,
        slots: roles.map((role, index) => ({
          id: crypto.randomUUID(),
          role,
          purpose: purposes[index]!,
          label: EFFECT_TEMPLATE_MIX_ROLE_LABELS[role],
          duration: 4,
          transition: '硬切',
          transitionDuration: 0,
        })),
      },
    },
  };
};
export const markEffectTemplateMixChanged = (
  workspace: EffectTemplateMixWorkspace,
  selectedVariantId: string,
): void => {
  workspace.editVersion++;
  workspace.template.editVersion++;
  for (const variant of workspace.variants) {
    if (variant.id === selectedVariantId) {
      variant.slots = cloneMix(workspace.template.slots);
      variant.appliedTemplateVersion = workspace.template.editVersion;
      variant.status = 'CURRENT';
    } else variant.status = 'PENDING';
  }
};
export const moveEffectTemplateMixSlot = (
  slots: EffectTemplateMixSlot[],
  slotId: string,
  direction: -1 | 1,
): EffectTemplateMixSlot[] => {
  const i = slots.findIndex((s) => s.id === slotId);
  const target = i + direction;
  if (i < 0 || target < 0 || target >= slots.length) return slots;
  const next = [...slots];
  const [slot] = next.splice(i, 1);
  next.splice(target, 0, slot!);
  return next;
};
export const effectTemplateMixTiming = (
  slots: readonly EffectTemplateMixSlot[],
): { duration: number; slots: { id: string; start: number; end: number }[] } => {
  let ticks = 0;
  const positions = slots.map((slot) => {
    const start = ticks / 10;
    ticks += Number.isFinite(slot.duration) ? Math.max(0, Math.round(slot.duration * 10)) : 0;
    return { id: slot.id, start, end: ticks / 10 };
  });
  return { duration: ticks / 10, slots: positions };
};
export const formatEffectTemplateMixTime = (seconds: number): string => {
  const ticks = Math.max(0, Math.round(seconds * 10));
  return (
    String(Math.floor(ticks / 600)).padStart(2, '0') +
    ':' +
    String(Math.floor(ticks / 10) % 60).padStart(2, '0') +
    '.' +
    (ticks % 10)
  );
};
