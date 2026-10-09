import { describe, expect, it } from 'vitest';
import {
  CUSTOMIZED_BRAND_IMAGE_USAGES,
  CUSTOMIZED_WORKFLOW_NODES,
  customizedWorkflowNodeId,
  emptyCustomizedImportDraft,
  restoreCustomizedImportDraft,
  normalizeCustomizedImportDraft,
  validateCustomizedImportDraft,
} from './customized-import';

describe('customized unified requirements source package', () => {
  it.each(CUSTOMIZED_BRAND_IMAGE_USAGES)(
    'round-trips brand usage %s without changing fixed file versions',
    (imageUsage) => {
      const draft = {
        ...emptyCustomizedImportDraft(),
        materials: [
          { assetId: 'brief', assetVersion: 2, category: 'BRIEF' as const },
          {
            assetId: 'z-brand',
            assetVersion: 3,
            category: 'VISUAL_REFERENCE' as const,
            imageUsage,
          },
        ],
      };
      const before = JSON.stringify(draft);
      expect(restoreCustomizedImportDraft(draft)).toEqual(draft);
      expect(normalizeCustomizedImportDraft(draft, new Set(['z-brand']))).toEqual(draft);
      expect(validateCustomizedImportDraft(draft)).toEqual([]);
      expect(JSON.stringify(draft)).toBe(before);
      expect(
        validateCustomizedImportDraft({ ...draft, materials: draft.materials.slice(1) }),
      ).toEqual(['请上传至少一份视频创作简报文档']);
    },
  );
  it.each(['PRODUCT', 'PERSON', 'SCENE', 'STYLE', 'OTHER'] as const)(
    'preserves historical usage %s instead of converting it into a brand asset',
    (imageUsage) => {
      const draft = {
        ...emptyCustomizedImportDraft(),
        materials: [
          {
            assetId: 'old-image',
            assetVersion: 7,
            category: 'VISUAL_REFERENCE' as const,
            imageUsage,
          },
        ],
      };
      const before = JSON.stringify(draft);
      expect(normalizeCustomizedImportDraft(draft, new Set(['old-image']))).toEqual(draft);
      expect(JSON.stringify(draft)).toBe(before);
    },
  );
  it('defines six stages and projects legacy asset navigation into shot rendering', () => {
    expect(CUSTOMIZED_WORKFLOW_NODES).toEqual([
      'SOURCE_IMPORT',
      'INFORMATION_EXTRACTION',
      'STORYBOARD',
      'SHOT_PROMPT',
      'SHOT_RENDER',
      'DELIVERY',
    ]);
    for (const node of CUSTOMIZED_WORKFLOW_NODES) expect(customizedWorkflowNodeId(node)).toBe(node);
    expect(customizedWorkflowNodeId('VISUAL_ASSETS')).toBe('SHOT_RENDER');
    for (const value of [null, undefined, '', 'UNKNOWN', 5])
      expect(customizedWorkflowNodeId(value)).toBeNull();
  });
  it('does not treat historical default video settings as customer requirements', () => {
    expect(
      restoreCustomizedImportDraft({
        schemaVersion: 1,
        coreMessage: '',
        brandTone: '',
        disabledElements: [],
        durationSeconds: 60,
        aspectRatio: '9:16',
        materials: [],
      }),
    ).toEqual(emptyCustomizedImportDraft());
  });
  it('retains historical text but requires a document for a new source package', () => {
    const draft = {
      ...emptyCustomizedImportDraft(),
      requirements: '制作品牌短片，产品规格以资料为准',
    };
    expect(validateCustomizedImportDraft(draft)).toEqual(['请上传至少一份视频创作简报文档']);
    expect(normalizeCustomizedImportDraft(draft)).toEqual(draft);
  });
  it('unifies old document categories and does not allow images to replace requirements', () => {
    const draft = {
      ...emptyCustomizedImportDraft(),
      materials: [
        { assetId: 'brief', assetVersion: 1, category: 'BRIEF' as const },
        { assetId: 'product', assetVersion: 2, category: 'PRODUCT' as const },
      ],
    };
    expect(validateCustomizedImportDraft(draft)).toEqual([]);
    expect(normalizeCustomizedImportDraft(draft).materials.map((item) => item.category)).toEqual([
      'BRIEF',
      'BRIEF',
    ]);
    expect(
      validateCustomizedImportDraft(
        normalizeCustomizedImportDraft(draft, new Set(['product', 'brief'])),
      ),
    ).toEqual(['请上传至少一份视频创作简报文档']);
  });
  it('merges both v2 text areas and retains all attachments without altering saved history', () => {
    const old = {
      schemaVersion: 2,
      customerRequirements: '温暖的品牌视频',
      productInformation: '规格：200g\n材质以附件为准',
      materials: [{ assetId: 'product', assetVersion: 2, category: 'PRODUCT' }],
    };
    const before = JSON.stringify(old);
    const restored = normalizeCustomizedImportDraft(old);
    expect(restored.requirements).toBe('温暖的品牌视频\n\n产品资料：\n规格：200g\n材质以附件为准');
    expect(restored.materials).toEqual([
      { assetId: 'product', assetVersion: 2, category: 'BRIEF' },
    ]);
    expect(normalizeCustomizedImportDraft(restored)).toEqual(restored);
    expect(JSON.stringify(old)).toBe(before);
  });
  it('preserves old customer constraints and every file reference without mutating the saved v1 state', () => {
    const old = {
      schemaVersion: 1,
      brandTone: '自然',
      coreMessage: '展示产品',
      disabledElements: ['不改包装'],
      durationSeconds: 30,
      aspectRatio: '16:9',
      materials: [{ assetId: 'person', assetVersion: 3, category: 'CHARACTER' }],
    };
    const before = JSON.stringify(old);
    const restored = normalizeCustomizedImportDraft(old, new Set(['person']));
    expect(restored.requirements).toBe(
      '展示产品\n品牌调性：自然\n禁止元素：不改包装\n视频总时长：30 秒\n画幅：16:9',
    );
    expect(restored.materials).toEqual([
      { assetId: 'person', assetVersion: 3, category: 'VISUAL_REFERENCE', imageUsage: 'PERSON' },
    ]);
    expect(normalizeCustomizedImportDraft(restored, new Set(['person']))).toEqual(restored);
    expect(JSON.stringify(old)).toBe(before);
  });
  it('rejects invalid schema, missing text fields, versions, categories and image usages', () => {
    for (const value of [
      { schemaVersion: 4 },
      { ...emptyCustomizedImportDraft(), requirements: null },
      { schemaVersion: 2, customerRequirements: '', productInformation: null, materials: [] },
      {
        ...emptyCustomizedImportDraft(),
        materials: [{ assetId: 'x', assetVersion: 0, category: 'BRIEF' }],
      },
      {
        ...emptyCustomizedImportDraft(),
        materials: [{ assetId: 'x', assetVersion: 1, category: 'UNKNOWN' }],
      },
      {
        ...emptyCustomizedImportDraft(),
        materials: [
          { assetId: 'x', assetVersion: 1, category: 'VISUAL_REFERENCE', imageUsage: 'UNKNOWN' },
        ],
      },
    ])
      expect(() => restoreCustomizedImportDraft(value)).toThrow('资料草稿格式不正确');
  });
});
