import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  effectSegmentRenderPromptDifference,
  effectPromptRenderSettingsIssues,
  type EffectSegmentRenderPromptBaseline,
  effectSegmentImportDescriptionValid,
  resolveEffectImportedRenderSettings,
  EFFECT_SEGMENT_IMPORT_FAILURE_CODES,
  EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES,
  EFFECT_SEGMENT_RENDER_BATCH_STATUSES,
  EFFECT_SEGMENT_RENDER_JOB_TYPE,
  EFFECT_SEGMENT_RENDER_LIMITS,
  EFFECT_SEGMENT_RENDER_ORIGINS,
  EFFECT_SEGMENT_RENDER_QUEUE,
  EFFECT_SEGMENT_RENDER_EXPORT_FORMATS,
  EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS,
  EFFECT_SEGMENT_RENDER_REPAIR_STATUSES,
  EFFECT_SEGMENT_RENDER_STATUSES,
  type EffectSegmentRenderRequestSnapshot,
} from './effect-segment-render';

describe('effect segment render contract', () => {
  it.each([4, 15, 16, 20, 21, 30])(
    'checks manual %s-second Prompt settings without silently routing',
    (durationSeconds) => {
      const defaults = {
        capabilityKey: 'SEEDANCE_1_0',
        ratio: '9:16',
        resolution: '720p',
      } as const;
      const source = { durationSeconds, origin: 'MANUAL' } as const;
      expect(effectPromptRenderSettingsIssues(defaults, source).length > 0).toBe(
        durationSeconds > 15,
      );
      expect(
        effectPromptRenderSettingsIssues(
          { ...defaults, capabilityKey: 'SEEDANCE_1_5_PRO' },
          source,
        ),
      ).toEqual([]);
      expect(defaults.capabilityKey).toBe('SEEDANCE_1_0');
    },
  );
  it('validates duration, ratio and resolution together, including 4K after choosing 2.5', () => {
    const settings = {
      capabilityKey: 'SEEDANCE_1_5_PRO',
      ratio: '9:16',
      resolution: '4k',
    } as const;
    expect(
      effectPromptRenderSettingsIssues(settings, { durationSeconds: 20, origin: 'MANUAL' }),
    ).toEqual(['该模型不支持 4k 分辨率']);
    expect(
      effectPromptRenderSettingsIssues(
        { ...settings, resolution: '1080p' },
        { durationSeconds: 20, origin: 'MANUAL' },
      ),
    ).toEqual([]);
    expect(
      effectPromptRenderSettingsIssues(
        { ...settings, resolution: '1080p' },
        { durationSeconds: 31, origin: 'MANUAL' },
      ),
    ).toHaveLength(1);
    expect(
      effectPromptRenderSettingsIssues(
        { ...settings, resolution: '1080p' },
        { durationSeconds: 20, origin: 'AI' },
      ),
    ).toHaveLength(1);
  });
  it('compares consumed Prompt content, not revision churn, and separates paid/free/deleted changes', () => {
    const baseline: EffectSegmentRenderPromptBaseline = {
      promptContentHash: 'body',
      sharedPromptHash: 'shared',
      targetDurationSeconds: 5,
      primaryPurpose: 'PRODUCT_DISPLAY',
      compatiblePurposes: ['PRODUCT_DISPLAY', 'HOOK'],
      creativeCore: '主线',
      sourcePrompt: { artifactId: 'source', revision: 1, contentHash: 'old-batch' },
    };
    const restored = {
      ...baseline,
      sourcePrompt: { ...baseline.sourcePrompt!, revision: 7, contentHash: 'latest-batch' },
      compatiblePurposes: [
        'HOOK',
        'PRODUCT_DISPLAY',
      ] as EffectSegmentRenderPromptBaseline['compatiblePurposes'],
    };
    expect(effectSegmentRenderPromptDifference(baseline, restored)).toBeUndefined();
    expect(
      effectSegmentRenderPromptDifference(baseline, { ...restored, promptContentHash: 'new' }),
    ).toBe('RENDER');
    expect(
      effectSegmentRenderPromptDifference(baseline, { ...restored, sharedPromptHash: 'new' }),
    ).toBe('RENDER');
    expect(
      effectSegmentRenderPromptDifference(baseline, { ...restored, targetDurationSeconds: 8 }),
    ).toBe('RENDER');
    expect(
      effectSegmentRenderPromptDifference(baseline, { ...restored, creativeCore: '新主线' }),
    ).toBe('METADATA');
    expect(effectSegmentRenderPromptDifference(baseline, null)).toBe('REMOVE');
  });
  it.each([
    ['SEEDANCE_2_0', 6, 720, 'SEEDANCE_2_0', '720p'],
    ['SEEDANCE_2_0', 15, 1080, 'SEEDANCE_2_0', '1080p'],
    ['SEEDANCE_2_0_FAST', 6, 1080, 'SEEDANCE_1_5_PRO', '1080p'],
    ['SEEDANCE_1_0', 15, 1080, 'SEEDANCE_1_5_PRO', '1080p'],
    ['SEEDANCE_1_5_PRO', 15, 2160, 'SEEDANCE_2_0', '4k'],
    ['SEEDANCE_2_0_FAST', 15, 3000, 'SEEDANCE_2_0', '4k'],
    ['SEEDANCE_2_0', 15.041667, 496, 'SEEDANCE_1_5_PRO', '720p'],
    ['SEEDANCE_2_0', 30, 2160, 'SEEDANCE_1_5_PRO', '1080p'],
  ] as const)(
    'routes %s / %ss / %sp without mutating global settings',
    (capabilityKey, durationSeconds, shortSidePixels, model, resolution) => {
      const settings = { capabilityKey, ratio: '9:16' as const, resolution: '720p' as const };
      expect(
        resolveEffectImportedRenderSettings(settings, { durationSeconds, shortSidePixels }),
      ).toEqual({ ...settings, capabilityKey: model, resolution });
      expect(settings.resolution).toBe('720p');
      expect(settings.capabilityKey).toBe(capabilityKey);
    },
  );
  it('preserves configured higher quality and supports legacy imports without dimensions', () => {
    const settings = {
      capabilityKey: 'SEEDANCE_2_0' as const,
      ratio: '16:9' as const,
      resolution: '4k' as const,
    };
    expect(resolveEffectImportedRenderSettings(settings, { durationSeconds: 6 })).toEqual(settings);
    expect(resolveEffectImportedRenderSettings(settings, { durationSeconds: 30 }).resolution).toBe(
      '1080p',
    );
  });
  it('shares a fixed safe failure-code contract with the Worker schema', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(__dirname, '../schemas/effect-video-import-failure.schema.json'),
        'utf8',
      ),
    );
    expect(schema.properties.failureCode.enum).toEqual(EFFECT_SEGMENT_IMPORT_FAILURE_CODES);
    expect(schema.required).toEqual(['projectId', 'failureCode']);
    for (const message of Object.values(EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES)) {
      expect(message).toMatch(/[\u4e00-\u9fff]/u);
      expect(message).not.toMatch(/https?:\/\/|stack|token/iu);
    }
  });
  it('limits each import selection to five independently confirmed videos', () => {
    expect(EFFECT_SEGMENT_RENDER_LIMITS.maxImportFilesPerOperation).toBe(5);
  });
  it('requires a prompt and legal primary/compatible purposes on import', () => {
    const valid = {
      promptText: '实际画面',
      primaryPurpose: 'HOOK',
      compatiblePurposes: ['HOOK', 'EFFECT'],
    };
    expect(effectSegmentImportDescriptionValid(valid)).toBe(true);
    expect(
      effectSegmentImportDescriptionValid({ ...valid, creativeCore: '', dimensions: {} }),
    ).toBe(true);
    expect(effectSegmentImportDescriptionValid({ ...valid, dimensions: { scene: '餐桌' } })).toBe(
      true,
    );
    expect(effectSegmentImportDescriptionValid({ ...valid, creativeCore: 'x'.repeat(161) })).toBe(
      false,
    );
    expect(
      effectSegmentImportDescriptionValid({ ...valid, dimensions: { scene: 'x'.repeat(121) } }),
    ).toBe(false);
    expect(
      effectSegmentImportDescriptionValid({ ...valid, dimensions: { unknown: '非法字段' } }),
    ).toBe(false);
    for (const changes of [
      { promptText: ' ' },
      { promptText: 'x'.repeat(4001) },
      { primaryPurpose: null },
      { primaryPurpose: 'PAIN' },
      { compatiblePurposes: [] },
      { compatiblePurposes: ['EFFECT'] },
      { compatiblePurposes: ['HOOK', 'HOOK'] },
      { compatiblePurposes: ['HOOK', 'PAIN'] },
    ])
      expect(effectSegmentImportDescriptionValid({ ...valid, ...changes })).toBe(false);
    expect(effectSegmentImportDescriptionValid(null)).toBe(false);
  });
  it('keeps queue routing and retry limits stable', () => {
    expect(EFFECT_SEGMENT_RENDER_QUEUE).toBe('effect.segment-render.requested');
    expect(EFFECT_SEGMENT_RENDER_JOB_TYPE).toBe('EFFECT_SEGMENT_RENDER');
    expect(EFFECT_SEGMENT_RENDER_LIMITS.maxAutoRetries).toBe(2);
    expect(EFFECT_SEGMENT_RENDER_LIMITS.maxAttempts).toBe(3);
    expect(EFFECT_SEGMENT_RENDER_LIMITS.maxPosterBytes).toBe(2 * 1024 * 1024);
    expect(EFFECT_SEGMENT_RENDER_LIMITS.maxImportFilesPerOperation).toBe(5);
  });

  it('covers page-facing task and batch states', () => {
    expect(EFFECT_SEGMENT_RENDER_STATUSES).toEqual([
      'AUTO_RETRY',
      'COMPLETED',
      'FAILED',
      'QUEUED',
      'RENDERING',
    ]);
    expect(EFFECT_SEGMENT_RENDER_BATCH_STATUSES).toContain('PARTIAL');
    expect(EFFECT_SEGMENT_RENDER_ORIGINS).toEqual(['AI_GENERATED', 'EXTERNAL_IMPORT']);
    expect(EFFECT_SEGMENT_RENDER_EXPORT_FORMATS).toEqual([
      'VIDEO_PACKAGE',
      'MANIFEST_JSON',
      'FAILURE_CSV',
    ]);
  });

  it('keeps one immutable provider request per prompt', () => {
    const snapshot: EffectSegmentRenderRequestSnapshot = {
      promptId: 'prompt-1',
      promptCode: 'P001',
      promptText: '一个独立视频素材片段。',
      primaryPurpose: 'PRODUCT_DISPLAY',
      compatiblePurposes: ['PRODUCT_DISPLAY'],
      promptContentHash: 'a'.repeat(64),
      sharedPromptHash: 'b'.repeat(64),
      renderSettingsHash: 'c'.repeat(64),
      sourcePackage: {
        artifactId: 'source-package-1',
        revision: 2,
        contentHash: 'e'.repeat(64),
      },
      inputImages: [
        {
          fileObjectId: 'image-1',
          originalFileName: 'main.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          contentHash: 'd'.repeat(64),
          sortOrder: 0,
        },
      ],
      request: {
        model: 'seedance-model',
        content: [{ type: 'text', text: '一个独立视频素材片段。' }],
        duration: 5,
        ratio: '9:16',
        resolution: '1080p',
      },
    };
    expect(snapshot.request.content).toHaveLength(1);
    expect(snapshot.inputImages).toHaveLength(1);
    expect(snapshot.promptId).toBe('prompt-1');
  });

  it('supports a versioned full-video repair without changing the source prompt', () => {
    const snapshot: EffectSegmentRenderRequestSnapshot = {
      operation: 'REPAIR',
      promptId: 'prompt-1',
      promptCode: 'P001',
      promptText: '原始 Prompt 保持只读。',
      primaryPurpose: 'PRODUCT_DISPLAY',
      compatiblePurposes: [],
      promptContentHash: 'a'.repeat(64),
      sharedPromptHash: 'b'.repeat(64),
      renderSettingsHash: 'c'.repeat(64),
      sourcePackage: {
        artifactId: 'source-package-1',
        revision: 2,
        contentHash: 'd'.repeat(64),
      },
      inputImages: [],
      inputVideo: {
        fileObjectId: 'video-1',
        originalFileName: 'R-001.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 2048,
        contentHash: 'e'.repeat(64),
        durationSeconds: 15,
      },
      repair: {
        sourceVersion: 1,
        startMs: 12000,
        endMs: 14000,
        instruction: '修复产品瓶口变形。',
        region: { x: 0.2, y: 0.3, width: 0.25, height: 0.2 },
      },
      request: {
        model: 'doubao-seedance-2-0',
        content: [{ type: 'text', text: '仅修改 12.000s 至 14.000s。' }],
        duration: 15,
        ratio: '9:16',
        resolution: '720p',
      },
    };

    expect(snapshot.inputImages).toEqual([]);
    expect(snapshot.inputVideo?.durationSeconds).toBe(15);
    expect(snapshot.repair?.sourceVersion).toBe(1);
    expect(EFFECT_SEGMENT_RENDER_REPAIR_STATUSES).toContain('READY');
    expect(EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS).toEqual(['ACCEPT', 'DISCARD']);
  });
});
