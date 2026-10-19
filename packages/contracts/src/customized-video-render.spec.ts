import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EFFECT_PROMPT_RENDER_CAPABILITY_KEYS,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
} from './effect-prompt-generation';
import {
  SEEDANCE_MODEL_OPTIONS,
  DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS as defaults,
  customizedVideoRenderIssues,
  isCustomizedVideoRenderSettings,
} from './customized-video-render';
describe('customized video render capabilities', () => {
  it('keeps worker schema fields and choices aligned with the shared contracts', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(__dirname, '../schemas/customized-video-render-input-v1.schema.json'),
        'utf8',
      ),
    );
    expect(schema.$defs.RenderSettings.properties.capabilityKey.enum).toEqual(
      EFFECT_PROMPT_RENDER_CAPABILITY_KEYS,
    );
    expect(schema.$defs.RenderSettings.properties.ratio.enum).toEqual(SEEDANCE_RATIOS);
    expect(schema.$defs.RenderSettings.properties.resolution.enum).toEqual(SEEDANCE_RESOLUTIONS);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['settings', 'model', 'clipId', 'title', 'seconds', 'prompt', 'references'].sort(),
    );
  });
  it('shares all four effect model choices and rejects unsupported resolution', () => {
    expect(SEEDANCE_MODEL_OPTIONS).toHaveLength(4);
    expect(isCustomizedVideoRenderSettings(defaults)).toBe(true);
    expect(
      isCustomizedVideoRenderSettings({
        ...defaults,
        capabilityKey: 'SEEDANCE_2_0_FAST',
        resolution: '4k',
      }),
    ).toBe(false);
    expect(isCustomizedVideoRenderSettings({ ...defaults, ratio: 'banana' })).toBe(false);
    expect(isCustomizedVideoRenderSettings({ ...defaults, capabilityKey: '__proto__' })).toBe(
      false,
    );
  });
  it('enforces duration and image count without silently modifying settings', () => {
    expect(customizedVideoRenderIssues(defaults, 15, 9)).toEqual([]);
    expect(customizedVideoRenderIssues(defaults, 16, 9)).toHaveLength(1);
    expect(customizedVideoRenderIssues(defaults, 9, 10)).toHaveLength(1);
    expect(customizedVideoRenderIssues(defaults, 9.1, 2)).toHaveLength(1);
    expect(
      customizedVideoRenderIssues({ ...defaults, capabilityKey: 'SEEDANCE_1_5_PRO' }, 30, 30),
    ).toEqual([]);
    expect(
      customizedVideoRenderIssues({ ...defaults, capabilityKey: 'SEEDANCE_1_5_PRO' }, 2, 0),
    ).toEqual([]);
    expect(customizedVideoRenderIssues(defaults, 9, 0)).toEqual([]);
  });
});
