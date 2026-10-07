import { createHash } from 'node:crypto';
import type {
  EffectPromptBatchResult,
  EffectSegmentRenderRequestSnapshot,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import {
  renderPromptBaseline,
  renderPromptUpdateKind,
} from './effect-segment-render-prompt-update';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fixture = () => {
  const snapshot = {
    promptId: 'prompt-a',
    promptContentHash: hash('正文'),
    sharedPromptHash: hash('共用'),
    request: { duration: 5 },
    primaryPurpose: 'PRODUCT_DISPLAY',
    compatiblePurposes: ['PRODUCT_DISPLAY', 'HOOK'],
    creativeCore: '创意',
    dimensions: {
      narrative: '叙事',
      scene: '厨房',
      persona: '手部',
      productRelation: '产品',
      camera: '近景',
      emotion: '自然',
    },
  } as EffectSegmentRenderRequestSnapshot;
  const batch = {
    sharedPrompt: { contentHash: hash('共用') },
    items: [
      {
        id: 'prompt-a',
        content: '正文',
        targetDurationSeconds: 5,
        primaryPurpose: snapshot.primaryPurpose,
        compatiblePurposes: [...snapshot.compatiblePurposes],
        creativeCore: snapshot.creativeCore,
        dimensions: { ...snapshot.dimensions },
      },
    ],
  } as EffectPromptBatchResult;
  return { snapshot, batch };
};

describe('confirmed Prompt/material differences', () => {
  it('compares rendering text, shared input and duration independently of batch revision', () => {
    const { snapshot, batch } = fixture();
    expect(renderPromptUpdateKind(snapshot, batch)).toBeUndefined();
    batch.items[0]!.content = '新正文';
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('RENDER');
    batch.items[0]!.content = '正文';
    batch.sharedPrompt!.contentHash = hash('新共用');
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('RENDER');
    batch.sharedPrompt!.contentHash = hash('共用');
    batch.items[0]!.targetDurationSeconds = 6;
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('RENDER');
  });
  it('treats metadata as a free sync and ignores compatible-purpose ordering', () => {
    const { snapshot, batch } = fixture();
    batch.items[0]!.compatiblePurposes.reverse();
    expect(renderPromptUpdateKind(snapshot, batch)).toBeUndefined();
    batch.items[0]!.dimensions.camera = '俯拍';
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('METADATA');
    batch.items[0]!.dimensions.camera = '近景';
    batch.items[0]!.creativeCore = '新创意';
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('METADATA');
  });
  it('does not invent missing historical metadata or update independent imported clips', () => {
    const { snapshot, batch } = fixture();
    delete snapshot.creativeCore;
    delete snapshot.dimensions;
    expect(renderPromptUpdateKind(snapshot, batch)).toBeUndefined();
    batch.items = [];
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('REMOVE');
    snapshot.importedMaterial = {} as NonNullable<typeof snapshot.importedMaterial>;
    expect(renderPromptUpdateKind(snapshot, batch)).toBeUndefined();
  });
  it('keeps the adopted baseline until completion, and detects a newer save after completion', () => {
    const { snapshot, batch } = fixture();
    snapshot.adoptedPrompt = renderPromptBaseline(snapshot);
    snapshot.promptContentHash = hash('新正文');
    batch.items[0]!.content = '新正文';
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('RENDER');
    snapshot.adoptedPrompt = renderPromptBaseline(snapshot);
    expect(renderPromptUpdateKind(snapshot, batch)).toBeUndefined();
    batch.items[0]!.content = '更新的正文';
    expect(renderPromptUpdateKind(snapshot, batch)).toBe('RENDER');
  });
});
