import type { EffectTemplateMixTemplateEntry } from '@ai-marketing/contracts';
import { stableJson } from './effect-template-mix-draft-race';

/** Navigation, counters and computed locks are not packaging input; cuts and audio are. */
export function samePackagingDraftInput(
  current: EffectTemplateMixTemplateEntry | undefined,
  incoming: EffectTemplateMixTemplateEntry | undefined,
): boolean {
  if (!current || !incoming || current.id !== incoming.id) return false;
  const input = (entry: EffectTemplateMixTemplateEntry) => ({
    template: entry.workspace.template,
    variants: entry.workspace.variants,
  });
  return stableJson(input(current)) === stableJson(input(incoming));
}
