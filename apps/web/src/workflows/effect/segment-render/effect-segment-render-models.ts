import { EFFECT_PROMPT_RENDER_CAPABILITIES } from '@ai-marketing/contracts';
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

export const effectSegmentRenderModels: readonly RenderModelOption[] = (
  [
    ['SEEDANCE_1_5_PRO', 'Doubao-Seedance-2.5'],
    ['SEEDANCE_2_0', 'Doubao-Seedance-2.0'],
    ['SEEDANCE_1_0', 'Doubao-Seedance-2.0-mini'],
    ['SEEDANCE_2_0_FAST', 'Doubao-Seedance-2.0-fast'],
  ] as const
).map(([value, label]) => ({
  value,
  label,
  ...EFFECT_PROMPT_RENDER_CAPABILITIES[value],
  defaultRatio: 'adaptive',
  defaultResolution: '720p',
}));
