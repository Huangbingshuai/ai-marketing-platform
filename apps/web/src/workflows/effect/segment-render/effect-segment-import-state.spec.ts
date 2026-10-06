import { describe, expect, it } from 'vitest';
import type { EffectSegmentImportDraft } from '@ai-marketing/contracts';
import { applyEffectSegmentImportRecognition } from './effect-segment-import-state';

const original = () =>
  ({
    id: 'draft',
    promptText: '用户填写',
    primaryPurpose: 'HOOK',
    compatiblePurposes: ['HOOK', 'CTA'],
    descriptionStatus: 'IDLE',
    creativeCore: '用户原创意',
    dimensions: { narrative: '用户原叙事' },
  }) as EffectSegmentImportDraft;

describe('external import recognition', () => {
  it.each(['QUEUED', 'RUNNING', 'FAILED'] as const)(
    'preserves all editable fields while %s',
    (descriptionStatus) => {
      const draft = original();
      applyEffectSegmentImportRecognition(draft, {
        ...draft,
        promptText: '服务端旧描述',
        primaryPurpose: 'PRODUCT_DISPLAY',
        compatiblePurposes: ['PRODUCT_DISPLAY'],
        descriptionStatus,
        creativeCore: '服务端旧创意',
        dimensions: { narrative: '旧叙事' },
      });
      expect(draft).toMatchObject({ ...original(), descriptionStatus });
    },
  );
  it('overwrites all editable fields, instead of merging user choices, on success', () => {
    const draft = original();
    const incoming: EffectSegmentImportDraft = {
      ...draft,
      promptText: 'AI 实际画面',
      primaryPurpose: 'EFFECT',
      compatiblePurposes: ['EFFECT', 'PRODUCT_DISPLAY'],
      descriptionStatus: 'COMPLETED',
      creativeCore: 'AI 新创意',
      dimensions: { scene: 'AI 新场景' },
    };
    applyEffectSegmentImportRecognition(draft, incoming);
    expect(draft).toEqual(incoming);
    expect(draft.dimensions).not.toHaveProperty('narrative');
    expect(draft.compatiblePurposes).not.toBe(incoming.compatiblePurposes);
    expect(draft.compatiblePurposes).not.toContain('HOOK');
  });
});
