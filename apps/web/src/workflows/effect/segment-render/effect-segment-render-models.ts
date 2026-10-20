import { EFFECT_PROMPT_RENDER_CAPABILITIES, SEEDANCE_MODEL_OPTIONS } from '@ai-marketing/contracts';
import type {
  EffectSegmentRenderSettings,
  SeedanceRatio,
  SeedanceResolution,
} from '@ai-marketing/contracts';

export type RenderModelOption = {
  value: EffectSegmentRenderSettings['capabilityKey'];
  label: string;
  ratios: readonly SeedanceRatio[];
  resolutions: readonly SeedanceResolution[];
  defaultRatio: SeedanceRatio;
  defaultResolution: SeedanceResolution;
};

export const effectSegmentRenderModels: readonly RenderModelOption[] = SEEDANCE_MODEL_OPTIONS.map(
  ({ value, label }) => ({
    value,
    label,
    ...EFFECT_PROMPT_RENDER_CAPABILITIES[value],
    defaultRatio: 'adaptive',
    defaultResolution: '720p',
  }),
);
