import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EFFECT_VIDEO_CONFIG,
  EFFECT_IMPORT_UPLOAD_MATERIAL_TYPES,
  EFFECT_IMPORT_STYLE_TONES,
  EFFECT_MANIFEST_COLUMNS,
  mergeEffectVideoConfig,
  normalizeEffectImportSku,
  type EffectVideoConfig,
} from './effect-import';

describe('标准化资料包', () => {
  it('只向新增上传和清单开放商品图片、产品文档', () => {
    expect(EFFECT_IMPORT_UPLOAD_MATERIAL_TYPES).toEqual(['PRODUCT_IMAGE', 'PRODUCT_DOCUMENT']);
    expect(EFFECT_MANIFEST_COLUMNS).toEqual(['电商链接', '商品图片', '产品文档']);
  });

  it('风格基调严格使用冻结原型选项', () => {
    expect(EFFECT_IMPORT_STYLE_TONES).toEqual([
      '烟火食欲感',
      '高端电影感',
      '自然电影感',
      '户外电影感',
      '清透冰感',
      '居家纪实',
      '香槟金电影感',
      '专业测评感',
      '温馨生活感',
      '国潮新中式',
      '清新田园',
      '复古胶片',
      '赛博霓虹',
      '极简商务',
      '治愈暖光',
      '夜景氛围',
    ]);
    expect(DEFAULT_EFFECT_VIDEO_CONFIG.styleTone).toBe('烟火食欲感');
  });
});

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
