import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  effectSegmentImportDescriptionValid,
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
  it('shares a fixed safe failure-code contract with the Worker schema', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../schemas/effect-video-import-failure.schema.json', import.meta.url),
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
