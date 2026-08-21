import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EFFECT_VIDEO_CONFIG,
  mergeEffectVideoConfig,
  normalizeEffectImportSku,
  type EffectVideoConfig,
} from './effect-import';

describe('normalizeEffectImportSku', () => {
  it('trims, applies NFKC normalization and compares case-insensitively', () => {
    expect(normalizeEffectImportSku('  ｓｋｕ-AbＣ-01  ')).toBe('SKU-ABC-01');
  });

  it('preserves a normalized empty value for server-side required validation', () => {
    expect(normalizeEffectImportSku('　 ')).toBe('');
  });
});

describe('mergeEffectVideoConfig', () => {
  it('inherits global fields and applies only explicit product overrides', () => {
    const globalConfig: EffectVideoConfig = {
      ...DEFAULT_EFFECT_VIDEO_CONFIG,
      disabledElements: ['竞品 Logo'],
    };

    expect(
      mergeEffectVideoConfig(globalConfig, {
        durationSeconds: 30,
        deliveryChannel: '小红书',
      }),
    ).toEqual({
      ...globalConfig,
      durationSeconds: 30,
      deliveryChannel: '小红书',
    });
  });

  it('returns an independent disabledElements array', () => {
    const globalConfig: EffectVideoConfig = {
      ...DEFAULT_EFFECT_VIDEO_CONFIG,
      disabledElements: ['烟草'],
    };
    const merged = mergeEffectVideoConfig(globalConfig, {});

    merged.disabledElements.push('酒精');

    expect(globalConfig.disabledElements).toEqual(['烟草']);
  });
});
