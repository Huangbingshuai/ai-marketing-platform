import { describe, expect, it } from 'vitest';

import {
  EFFECT_SEGMENT_RENDER_BATCH_STATUSES,
  EFFECT_SEGMENT_RENDER_JOB_TYPE,
  EFFECT_SEGMENT_RENDER_LIMITS,
  EFFECT_SEGMENT_RENDER_QUEUE,
  EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS,
  EFFECT_SEGMENT_RENDER_REPAIR_STATUSES,
  EFFECT_SEGMENT_RENDER_STATUSES,
  type EffectSegmentRenderRequestSnapshot,
} from './effect-segment-render';

describe('effect segment render contract', () => {
  it('keeps queue routing and retry limits stable', () => {
    expect(EFFECT_SEGMENT_RENDER_QUEUE).toBe('effect.segment-render.requested');
    expect(EFFECT_SEGMENT_RENDER_JOB_TYPE).toBe('EFFECT_SEGMENT_RENDER');
    expect(EFFECT_SEGMENT_RENDER_LIMITS.maxAutoRetries).toBe(2);
    expect(EFFECT_SEGMENT_RENDER_LIMITS.maxAttempts).toBe(3);
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
