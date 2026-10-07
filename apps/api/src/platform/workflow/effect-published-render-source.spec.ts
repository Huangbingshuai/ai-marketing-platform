import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hasAdoptedRenderPrompt,
  publishedRenderSource,
  recoverPublishedRenderPrompt,
} from './effect-published-render-source';

const payload = {
  promptText: '实际采用正文',
  adoptedPrompt: {
    promptContentHash: createHash('sha256').update('实际采用正文').digest('hex'),
  },
};
const clip = {
  nodeId: 'SEGMENT_RENDER',
  artifactKey: 'render-clip:a',
  freshness: 'STALE',
  availability: 'AVAILABLE',
  payload,
  metadata: { promptSourcePending: true },
};

describe('published render source consumer projection', () => {
  it('recovers legacy provenance only from the actual matching video snapshot, never a newer or foreign task', () => {
    const legacy = {
      ...clip,
      workflowRunId: 'run',
      payload: {
        taskId: 'task',
        promptId: 'prompt',
        fileObjectId: 'file',
        promptContentHash: payload.adoptedPrompt.promptContentHash,
      },
    };
    const task = {
      id: 'task',
      workflowRunId: 'run',
      promptId: 'prompt',
      outputFileObjectId: 'file',
      requestSnapshot: {
        promptText: '实际采用正文',
        promptContentHash: payload.adoptedPrompt.promptContentHash,
        sharedPromptHash: 'shared',
        request: { duration: 5 },
        primaryPurpose: 'PRODUCT_DISPLAY',
        compatiblePurposes: [],
        sourcePrompt: { artifactId: 'source', revision: 1, contentHash: 'old' },
      },
      generationRequestSnapshot: null,
    };
    const recovered = recoverPublishedRenderPrompt(legacy, [task]);
    expect(hasAdoptedRenderPrompt(recovered.payload)).toBe(true);
    expect(legacy.payload).not.toHaveProperty('adoptedPrompt');
    for (const wrong of [
      { ...task, workflowRunId: 'other' },
      { ...task, promptId: 'same-text-other-source' },
      { ...task, outputFileObjectId: 'new-video' },
      { ...task, requestSnapshot: { ...task.requestSnapshot, promptText: '最新正文' } },
    ])
      expect(recoverPublishedRenderPrompt(legacy, [wrong]).payload).toEqual(legacy.payload);
    const pool = recoverPublishedRenderPrompt({ ...legacy, payload: { clips: [legacy.payload] } }, [
      task,
    ]);
    expect(hasAdoptedRenderPrompt((pool.payload as { clips: unknown[] }).clips[0])).toBe(true);
  });
  it('retains the confirmed video and its actual Prompt while upstream editing awaits adoption', () => {
    expect(hasAdoptedRenderPrompt(payload)).toBe(true);
    expect(publishedRenderSource(clip).freshness).toBe('CURRENT');
    expect(clip.freshness).toBe('STALE');
    expect(
      publishedRenderSource({
        ...clip,
        artifactKey: 'render-batch:p',
        payload: { clips: [payload] },
      }).freshness,
    ).toBe('CURRENT');
  });
  it('does not bypass unavailable files, independent warnings, or unproven historical inputs', () => {
    expect(publishedRenderSource({ ...clip, availability: 'UNAVAILABLE' }).freshness).toBe('STALE');
    expect(publishedRenderSource({ ...clip, metadata: {} }).freshness).toBe('STALE');
    expect(
      publishedRenderSource({ ...clip, payload: { ...payload, promptText: '最新而非已采用正文' } })
        .freshness,
    ).toBe('STALE');
    expect(
      publishedRenderSource({
        ...clip,
        artifactKey: 'render-batch:p',
        payload: { clips: [payload, {}] },
      }).freshness,
    ).toBe('STALE');
    expect(publishedRenderSource({ ...clip, nodeId: 'TEMPLATE_MIX' }).freshness).toBe('STALE');
  });
});
