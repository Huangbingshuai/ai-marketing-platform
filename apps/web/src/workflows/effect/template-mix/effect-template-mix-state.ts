import type {
  EffectTemplateMixPurpose,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixTransition,
  EffectTemplateMixWorkspace,
  EffectTemplateMixTemplateEntry,
} from '@ai-marketing/contracts';
export type * from '@ai-marketing/contracts';

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
];
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
          duration: 3,
          transition: '硬切',
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
