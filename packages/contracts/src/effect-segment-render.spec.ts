import { describe, expect, it } from 'vitest';

import {
  EFFECT_SEGMENT_RENDER_BATCH_STATUSES,
  EFFECT_SEGMENT_RENDER_JOB_TYPE,
  EFFECT_SEGMENT_RENDER_LIMITS,
  EFFECT_SEGMENT_RENDER_QUEUE,
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
      request: {
        model: 'seedance-model',
        content: [{ type: 'text', text: '一个独立视频素材片段。' }],
        duration: 5,
        ratio: '9:16',
        resolution: '1080p',
      },
    };
    expect(snapshot.request.content).toHaveLength(1);
    expect(snapshot.promptId).toBe('prompt-1');
  });
});
