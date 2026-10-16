import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CUSTOMIZED_IMAGE_SETTINGS_SCHEMA,
  CUSTOMIZED_IMAGE_MODELS,
  isCustomizedImageSettings,
} from './customized-image-generation';

describe('customized image generation settings', () => {
  const value = {
    model: CUSTOMIZED_IMAGE_MODELS[0].id,
    resolution: '2K',
    ratio: '1:1',
    assetIds: ['product'],
  };
  it('shares the worker JSON Schema', () => {
    expect(
      JSON.parse(
        readFileSync(
          resolve(__dirname, '../schemas/customized-image-settings.schema.json'),
          'utf8',
        ),
      ),
    ).toEqual(CUSTOMIZED_IMAGE_SETTINGS_SCHEMA);
  });
  it('accepts pinned models and bounded unique objects', () => {
    for (const model of CUSTOMIZED_IMAGE_MODELS)
      expect(isCustomizedImageSettings({ ...value, model: model.id })).toBe(true);
  });
  it('validates per-object prompts and exact-version image references', () => {
    const reference = { assetId: 'b3cc83ca-c891-4b04-b660-9a593a86e1da', version: 2 };
    const input = { assetId: 'product', prompt: '暖白釉面陶瓷杯', references: [reference] };
    expect(isCustomizedImageSettings({ ...value, ratio: 'auto', inputs: [input] })).toBe(true);
    for (const inputs of [
      [],
      [{ ...input, assetId: 'other' }],
      [{ ...input, prompt: ' ' }],
      [{ ...input, references: [{ ...reference, version: 0 }] }],
      [{ ...input, references: [reference, reference] }],
      [{ ...input, references: [{ url: 'https://private.invalid' }] }],
    ])
      expect(isCustomizedImageSettings({ ...value, inputs })).toBe(false);
  });
  it.each([
    {},
    { ...value, model: 'automatic' },
    { ...value, resolution: '4K' },
    { ...value, assetIds: [] },
    { ...value, assetIds: ['x', 'x'] },
    { ...value, assetIds: Array.from({ length: 21 }, (_, i) => String(i)) },
    { ...value, extra: true },
  ])('rejects invalid settings', (input) => {
    expect(isCustomizedImageSettings(input)).toBe(false);
  });
});
