import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import { effectTemplateMixSourceChanges } from '@ai-marketing/contracts';
import type { EffectTemplateMixMaterial, EffectTemplateMixVariant } from '@ai-marketing/contracts';

/** Share a derived result, not a snapshot: deep edits still invalidate Vue's dependencies. */
export function createMixSourceChangesReader() {
  const variants = new WeakMap<
    EffectTemplateMixVariant,
    WeakMap<
      EffectTemplateMixMaterial[],
      ComputedRef<ReturnType<typeof effectTemplateMixSourceChanges>>
    >
  >();
  return (variant: EffectTemplateMixVariant, materials: EffectTemplateMixMaterial[]) => {
    let pools = variants.get(variant);
    if (!pools) {
      pools = new WeakMap();
      variants.set(variant, pools);
    }
    let changes = pools.get(materials);
    if (!changes) {
      changes = computed(() => effectTemplateMixSourceChanges(variant, materials));
      pools.set(materials, changes);
    }
    return changes.value;
  };
}
