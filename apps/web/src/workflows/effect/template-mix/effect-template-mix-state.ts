import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixPurpose,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixTransition,
  EffectTemplateMixVariant,
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
export const materialFits = (
  material: EffectTemplateMixMaterial,
  slot: EffectTemplateMixSlot,
  offset = 0,
): boolean =>
  material.available &&
  (material.purpose === slot.purpose || material.compatiblePurposes.includes(slot.purpose)) &&
  offset >= 0 &&
  material.duration + 0.001 >= slot.duration + offset;

/** Bipartite matching avoids greedy shortages when a multi-purpose clip is needed later. */
export const fillEffectTemplateMixVariant = (
  workspace: EffectTemplateMixWorkspace,
  variant: EffectTemplateMixVariant,
): void => {
  const used = new Set<string>();
  const assignment = new Map<string, string>();
  const slots = variant.slots;
  const candidates = (slot: EffectTemplateMixSlot) =>
    workspace.materials
      .filter((m) => materialFits(m, slot))
      .sort((a, b) => {
        const usage = (id: string) =>
          workspace.variants.filter(
            (v) => v.id !== variant.id && Object.values(v.bindings).includes(id),
          ).length;
        return (
          usage(a.id) - usage(b.id) ||
          Number(b.purpose === slot.purpose) - Number(a.purpose === slot.purpose) ||
          a.id.localeCompare(b.id)
        );
      });
  const fixed = new Set(variant.manualSlotIds);
  variant.conflictSlotIds = [];
  for (const slot of slots.filter((s) => fixed.has(s.id))) {
    const m = workspace.materials.find((item) => item.id === variant.bindings[slot.id]);
    if (!m || used.has(m.id) || !materialFits(m, slot, variant.offsets[slot.id] ?? 0))
      variant.conflictSlotIds.push(slot.id);
    if (m) used.add(m.id);
  }
  const bind = (slot: EffectTemplateMixSlot, seen: Set<string>): boolean => {
    for (const m of candidates(slot)) {
      if (used.has(m.id) || seen.has(m.id)) continue;
      seen.add(m.id);
      const previous = assignment.get(m.id);
      if (
        !previous ||
        bind(
          slots.find((s) => s.id === previous)!,
          seen,
        )
      ) {
        assignment.set(m.id, slot.id);
        return true;
      }
    }
    return false;
  };
  for (const slot of slots.filter((s) => !fixed.has(s.id))) {
    delete variant.bindings[slot.id];
    delete variant.bindingRevisions[slot.id];
    delete variant.offsets[slot.id];
    if (!bind(slot, new Set())) variant.conflictSlotIds.push(slot.id);
  }
  for (const [materialId, slotId] of assignment) {
    variant.bindings[slotId] = materialId;
    variant.bindingRevisions[slotId] =
      workspace.materials.find((item) => item.id === materialId)?.artifactRevision ?? 0;
  }
};
export const createEffectTemplateMixVariant = (
  workspace: EffectTemplateMixWorkspace,
  index = workspace.variants.length,
): EffectTemplateMixVariant => {
  const variant: EffectTemplateMixVariant = {
    id: crypto.randomUUID(),
    name: workspace.template.name + ' · ' + (index + 1),
    appliedTemplateVersion: workspace.template.editVersion,
    slots: cloneMix(workspace.template.slots),
    bindings: {},
    bindingRevisions: {},
    offsets: {},
    manualSlotIds: [],
    conflictSlotIds: [],
    status: 'CURRENT',
    captions: [],
    subtitleStyle: 'standard',
    bgm: null,
    voice: null,
    originalVolume: 1,
  };
  fillEffectTemplateMixVariant(workspace, variant);
  return variant;
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
export const syncEffectTemplateMixVariants = (
  workspace: EffectTemplateMixWorkspace,
  selectedVariantId: string,
): { conflicts: number; synced: number } => {
  let conflicts = 0;
  let synced = 0;
  for (const variant of workspace.variants) {
    if (variant.id === selectedVariantId) continue;
    variant.slots = cloneMix(workspace.template.slots);
    const ids = new Set(variant.slots.map((s) => s.id));
    variant.bindings = Object.fromEntries(
      Object.entries(variant.bindings).filter(([id]) => ids.has(id)),
    );
    variant.bindingRevisions = Object.fromEntries(
      Object.entries(variant.bindingRevisions).filter(([id]) => ids.has(id)),
    );
    variant.offsets = Object.fromEntries(
      Object.entries(variant.offsets).filter(([id]) => ids.has(id)),
    );
    variant.manualSlotIds = variant.manualSlotIds.filter((id) => ids.has(id));
    fillEffectTemplateMixVariant(workspace, variant);
    variant.appliedTemplateVersion = workspace.template.editVersion;
    variant.status = 'SYNCED';
    conflicts += variant.conflictSlotIds.length;
    synced++;
  }
  return { conflicts, synced };
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
