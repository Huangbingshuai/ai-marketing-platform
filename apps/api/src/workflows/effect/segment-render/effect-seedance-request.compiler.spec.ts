import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  EffectSegmentRenderSettings,
} from '@ai-marketing/contracts';
import { DEFAULT_EFFECT_PROMPT_SETTINGS } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  compileEffectSeedanceRequest,
  compileEffectSeedanceRepairRequest,
  type EffectSeedanceCompileError,
  validateEffectSeedanceTaskResult,
} from './effect-seedance-request.compiler';
import {
  compileEffectPromptSharedPrompt,
  recomputePromptQuality,
} from '../prompt-generation/effect-prompt.quality';

const item: EffectPromptItem = {
  id: 'prompt-1',
  code: 'P001',
  origin: 'AI',
  fragmentType: 'PRODUCT_DISPLAY',
  primaryPurpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: ['PRODUCT_DISPLAY'],
  classificationStatus: 'VERIFIED',
  productRelevance: 95,
  targetDurationSeconds: 5,
  creativeCore: '家庭厨房中的产品入画展示',
  dimensions: {
    narrative: '产品入画',
    scene: '家庭厨房',
    persona: '一名成年女性',
    productRelation: '切面油润可见',
    camera: '低机位近景缓慢推近',
    emotion: '暖调自然光',
  },
  content:
    '家庭厨房里，一名成年女性拿起广式腊肠并轻放到木质案板中央，低机位近景缓慢推近，暖调自然光勾出真实切面，结束时产品保持清楚可辨。',
  insightBindings: [],
  manualEdited: false,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
};

const batch = (capabilityKey: EffectPromptBatchResult['renderProfile']['capabilityKey']) => {
  const disabledElements = ['医疗功效', '未成年人'];
  return recomputePromptQuality(
    [item],
    DEFAULT_EFFECT_PROMPT_SETTINGS,
    undefined,
    {
      ratio: '9:16',
      resolution: '1080p',
      capabilityKey,
      sharedConstraints: {
        disabledElements,
        contentHash: 'a'.repeat(64),
      },
    },
    compileEffectPromptSharedPrompt(disabledElements, '保持产品外观前后一致。'),
  ) as EffectPromptBatchResult;
};

const renderSettings = (
  capabilityKey: EffectSegmentRenderSettings['capabilityKey'] = 'SEEDANCE_2_0',
  resolution: EffectSegmentRenderSettings['resolution'] = '720p',
): EffectSegmentRenderSettings => ({ ratio: '9:16', resolution, capabilityKey });

describe('effect Seedance request compiler', () => {
  it('keeps technical settings outside the visible prompt and appends shared constraints once', () => {
    const compiled = compileEffectSeedanceRequest(
      batch('SEEDANCE_2_0'),
      item.id,
      'seedance-model',
      renderSettings(),
    );
    expect(compiled.request).toMatchObject({
      duration: 5,
      ratio: '9:16',
      resolution: '720p',
    });
    expect(compiled.request.content[0].text).toContain(
      '画面中不得出现以下内容：医疗功效；未成年人。\n保持产品外观前后一致。',
    );
    expect(compiled.request.content[0].text.match(/医疗功效/gu)).toHaveLength(1);
    expect(compiled.request.content[0].text).toContain(item.content);
    expect(compiled.request.content[0].text).not.toContain('创意主线：');
    expect(compiled.request.content[0].text).not.toContain('六维创意信息：');
    expect(compiled.request.content[0].text).not.toContain('叙事结构：');
    expect(compiled.sharedPromptHash).toBe(batch('SEEDANCE_2_0').sharedPrompt?.contentHash);
    expect(item.content).not.toContain('9:16');
  });

  it('keeps the provider request and prompt fingerprint stable when only creative metadata changes', () => {
    const original = batch('SEEDANCE_2_0');
    const changed = batch('SEEDANCE_2_0');
    changed.items[0] = {
      ...changed.items[0]!,
      creativeCore: '改为突出节庆礼赠的创意方向',
      dimensions: {
        ...changed.items[0]!.dimensions,
        emotion: '节庆热闹氛围',
      },
    };

    const before = compileEffectSeedanceRequest(
      original,
      item.id,
      'seedance-model',
      renderSettings(),
    );
    const after = compileEffectSeedanceRequest(
      changed,
      item.id,
      'seedance-model',
      renderSettings(),
    );

    expect(after.promptContentHash).toBe(before.promptContentHash);
    expect(after.request).toEqual(before.request);
  });

  it('rejects 1080p for Seedance 2.0 fast without silent downgrade', () => {
    expect(() =>
      compileEffectSeedanceRequest(
        batch('SEEDANCE_2_0_FAST'),
        item.id,
        'fast',
        renderSettings('SEEDANCE_2_0_FAST', '1080p'),
      ),
    ).toThrow(
      expect.objectContaining<Partial<EffectSeedanceCompileError>>({
        code: 'RESOLUTION_UNSUPPORTED',
      }),
    );
  });

  it('accepts the workflow maximum of 15 seconds for Seedance 2.0 mini', () => {
    const current = batch('SEEDANCE_1_0');
    current.items[0] = { ...current.items[0]!, targetDurationSeconds: 15 };

    const compiled = compileEffectSeedanceRequest(
      current,
      item.id,
      'doubao-seedance-2-0-mini-260615',
      renderSettings('SEEDANCE_1_0'),
    );

    expect(compiled.request.duration).toBe(15);
  });

  it('rejects an item whose purpose evaluation is pending', () => {
    const current = batch('SEEDANCE_2_0');
    current.items[0] = { ...current.items[0]!, classificationStatus: 'PENDING' };
    expect(() =>
      compileEffectSeedanceRequest(current, item.id, 'seedance-model', renderSettings()),
    ).toThrow(
      expect.objectContaining<Partial<EffectSeedanceCompileError>>({
        code: 'CLASSIFICATION_PENDING',
      }),
    );
  });

  it('rejects an item whose evaluator asked for revision', () => {
    const current = batch('SEEDANCE_2_0');
    current.items[0] = {
      ...current.items[0]!,
      classificationStatus: 'NEEDS_REVISION',
      reviewIssues: ['PRODUCT_UNRELATED'],
    };
    expect(() =>
      compileEffectSeedanceRequest(current, item.id, 'seedance-model', renderSettings()),
    ).toThrow(
      expect.objectContaining<Partial<EffectSeedanceCompileError>>({
        code: 'CLASSIFICATION_PENDING',
      }),
    );
  });

  it('checks the echoed task parameters against the immutable request snapshot', () => {
    const snapshot = compileEffectSeedanceRequest(
      batch('SEEDANCE_2_0'),
      item.id,
      'seedance-model',
      renderSettings(),
    );
    expect(
      validateEffectSeedanceTaskResult(snapshot, {
        duration: '4',
        ratio: '16:9',
        resolution: '480P',
      }),
    ).toEqual(['DURATION_MISMATCH', 'RATIO_MISMATCH', 'RESOLUTION_MISMATCH']);
  });

  it('compiles a full-video repair request without copying the original prompt', () => {
    const original = compileEffectSeedanceRequest(
      batch('SEEDANCE_2_0'),
      item.id,
      'seedance-model',
      renderSettings(),
    );
    const generationSnapshot = {
      ...original,
      promptCode: item.code,
      promptText: item.content,
      sourcePackage: {
        artifactId: 'source-package-1',
        revision: 1,
        contentHash: 'd'.repeat(64),
      },
      inputImages: [],
    };
    const compiled = compileEffectSeedanceRepairRequest(
      generationSnapshot,
      {
        fileObjectId: 'video-1',
        originalFileName: 'R-001.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 2048,
        contentHash: 'e'.repeat(64),
        durationSeconds: 5,
      },
      {
        sourceVersion: 1,
        startMs: 1200,
        endMs: 2800,
        instruction: '修复产品瓶口变形',
        region: { x: 0.2, y: 0.3, width: 0.25, height: 0.2 },
      },
      'doubao-seedance-2-5-260628',
    );

    expect(compiled.operation).toBe('REPAIR');
    expect(compiled.request.model).toBe('doubao-seedance-2-5-260628');
    expect(compiled.inputImages).toEqual([]);
    expect(compiled.inputVideo?.fileObjectId).toBe('video-1');
    expect(compiled.request.content[0].text).toContain('[1.200s-2.800s]');
    expect(compiled.request.content[0].text).toContain('修复产品瓶口变形');
    expect(compiled.request.content[0].text).not.toContain(item.content);
    expect(compiled.promptText).toBe(item.content);
  });

  it('rejects a repair range outside the original video', () => {
    const original = compileEffectSeedanceRequest(
      batch('SEEDANCE_2_0'),
      item.id,
      'seedance-model',
      renderSettings(),
    );
    expect(() =>
      compileEffectSeedanceRepairRequest(
        {
          ...original,
          promptCode: item.code,
          promptText: item.content,
          sourcePackage: {
            artifactId: 'source-package-1',
            revision: 1,
            contentHash: 'd'.repeat(64),
          },
          inputImages: [],
        },
        {
          fileObjectId: 'video-1',
          originalFileName: 'R-001.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 2048,
          contentHash: 'e'.repeat(64),
          durationSeconds: 5,
        },
        {
          sourceVersion: 1,
          startMs: 4000,
          endMs: 6000,
          instruction: '修复产品瓶口变形',
          region: null,
        },
        'doubao-seedance-2-5-260628',
      ),
    ).toThrow(
      expect.objectContaining<Partial<EffectSeedanceCompileError>>({
        code: 'REPAIR_RANGE_INVALID',
      }),
    );
  });
});
