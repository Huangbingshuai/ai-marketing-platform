import type { EffectTemplateMixTemplate } from '@ai-marketing/contracts';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

export const templateConfigurationHash = (template: EffectTemplateMixTemplate): string =>
  workflowStateHash({
    name: template.name.trim(),
    slots: template.slots.map((slot) => ({
      id: slot.id,
      role: slot.role,
      label: slot.label,
      duration: slot.duration,
      transition: slot.transition,
      transitionDuration: slot.transitionDuration ?? null,
    })),
  });
