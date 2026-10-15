import { createHash } from 'node:crypto';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  type EffectPromptItem,
  type EffectPromptSemanticEvaluation,
  type EffectSegmentRenderRequestSnapshot,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../database/prisma.service';
import { renderPromptUpdateKind } from '../segment-render/effect-segment-render-prompt-update';
import { EffectPromptRepository } from './effect-prompt.repository';
import {
  parseEffectPromptStoredDraft,
  pendingEffectPromptSemanticEvaluation,
  recomputePromptQuality,
} from './effect-prompt.quality';

const batchEvaluation: EffectPromptSemanticEvaluation = {
  status: 'VERIFIED',
  duplicateRate: 50,
  duplicateCount: 1,
  evaluatedCount: 2,
  duplicateGroupCount: 1,
};

const fixture = () => {
  const originalItems: EffectPromptItem[] = [1, 2].map((number) => ({
    id: `00000000-0000-4000-8000-00000000000${number}`,
    code: `P00${number}`,
    origin: 'AI',
    fragmentType: 'PRODUCT_DISPLAY',
    primaryPurpose: 'PRODUCT_DISPLAY',
    compatiblePurposes: ['PRODUCT_DISPLAY'],
    classificationStatus: 'VERIFIED',
    productRelevance: 90,
    targetDurationSeconds: 15,
    creativeCore: `素材创意 ${number}`,
    dimensions: {
      narrative: '展示',
      scene: '室内',
      persona: '手部',
      productRelation: '商品',
      camera: '近景',
      emotion: '自然',
    },
    content: `原始画面 ${number}`,
    insightBindings: [],
    reviewIssues: [],
    manualEdited: false,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  }));
  const draft = recomputePromptQuality(originalItems, DEFAULT_EFFECT_PROMPT_SETTINGS,
    { semanticEvaluation: batchEvaluation });
  let row = {
    id: 'result',
    projectId: 'project',
    workflowRunId: 'workflow',
    runId: 'run',
    productId: 'product',
    revision: 1,
    draftResult: draft,
    generatedResult: structuredClone(draft),
    manualOverrides: { added: [], edited: {}, deleted: [] },
    savedAt: new Date('2026-10-10T00:00:00.000Z'),
  };
  const update = vi.fn(({ data }: { data: Record<string, unknown> }) => {
    row = { ...row, ...data, revision: row.revision + 1 } as typeof row;
    return row;
  });
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: row.id }]),
    effectPromptResult: { findFirst: vi.fn(() => row), update },
  };
  const repository = new EffectPromptRepository({
    $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
  } as unknown as PrismaService);
  const save = (index: number, content: string, revision = row.revision) => {
    const item = row.draftResult.items[index]!;
    return repository.mutateResult('project', 'result', revision, {
      kind: 'UPDATE',
      itemId: item.id,
      item: {
        content,
        fragmentType: item.fragmentType,
        primaryPurpose: item.primaryPurpose,
        compatiblePurposes: [...item.compatiblePurposes],
        classificationStatus: item.classificationStatus,
        productRelevance: 0,
        targetDurationSeconds: item.targetDurationSeconds,
        creativeCore: item.creativeCore,
        dimensions: { ...item.dimensions },
        reviewIssues: [...(item.reviewIssues ?? [])],
      },
    });
  };
  const snapshots = originalItems.map(
    (item) =>
      ({
        promptId: item.id,
        promptContentHash: createHash('sha256').update(item.content).digest('hex'),
        sharedPromptHash:
          draft.sharedPrompt?.contentHash ?? draft.renderProfile.sharedConstraints.contentHash,
        request: { duration: item.targetDurationSeconds },
        primaryPurpose: item.primaryPurpose,
        compatiblePurposes: [...item.compatiblePurposes],
        creativeCore: item.creativeCore,
        dimensions: { ...item.dimensions },
      }) as EffectSegmentRenderRequestSnapshot,
  );
  const pending = () =>
    snapshots.map((snapshot) => renderPromptUpdateKind(snapshot, row.draftResult));
  const remove = (id: string) => repository.mutateResult('project', 'result', row.revision,
    { kind: 'DELETE', itemId: id });
  const add = () => repository.mutateResult('project', 'result', row.revision, {
    kind: 'ADD', item: { ...originalItems[0]!, id: 'manual', code: 'P003', origin: 'MANUAL' },
  });
  return { save, add, remove, update, pending, row: () => row };
};

describe('manual Prompt saves and consumed render baselines', () => {
  it('preserves the AI assessment through add, edit, delete and deleting all items without stage outputs', async () => {
    const f = fixture();
    for (const action of [
      () => f.add(),
      () => f.save(0, '人工修改正文'),
      () => f.remove('manual'),
      () => f.remove(f.row().draftResult.items[0]!.id),
      () => f.remove(f.row().draftResult.items[0]!.id),
    ]) {
      await expect(action()).resolves.toMatchObject({ kind: 'UPDATED' });
      expect(f.row().draftResult.metrics.semanticEvaluation).toEqual(batchEvaluation);
      expect(f.row().generatedResult.metrics.semanticEvaluation).toEqual(batchEvaluation);
    }
    expect(f.row().draftResult.items).toEqual([]);
    expect(f.row().draftResult.metrics.acceptedCount).toBe(0);
  });

  it('restores a lost assessment only from the same result snapshot without changing revisions or content', async () => {
    const f = fixture();
    f.row().draftResult.metrics.semanticEvaluation = pendingEffectPromptSemanticEvaluation();
    const before = structuredClone(f.row());
    const projected = parseEffectPromptStoredDraft(f.row());
    expect(projected?.metrics.semanticEvaluation).toEqual(batchEvaluation);
    expect(projected?.items).toEqual(before.draftResult.items);
    expect(f.row()).toEqual(before);
    expect(f.update).not.toHaveBeenCalled();
    await f.remove(f.row().draftResult.items[0]!.id);
    expect(f.row().draftResult.metrics.semanticEvaluation).toEqual(batchEvaluation);
  });

  it('uses the original batch even if an old deletion recalculated a different verified score', () => {
    const f = fixture();
    f.row().draftResult.metrics.semanticEvaluation = { ...batchEvaluation, duplicateRate: 0,
      duplicateCount: 0, duplicateGroupCount: 0 };
    expect(parseEffectPromptStoredDraft(f.row())?.metrics.semanticEvaluation).toEqual(batchEvaluation);
  });

  it('does not invent an assessment for a batch without a verified generated snapshot', () => {
    const f = fixture();
    const pending = pendingEffectPromptSemanticEvaluation();
    f.row().draftResult.metrics.semanticEvaluation = pending;
    f.row().generatedResult.metrics.semanticEvaluation = pending;
    expect(parseEffectPromptStoredDraft(f.row())?.metrics.semanticEvaluation).toEqual(pending);
    expect(parseEffectPromptStoredDraft({ draftResult: f.row().draftResult })?.metrics.semanticEvaluation)
      .toEqual(pending);
    expect(parseEffectPromptStoredDraft({ draftResult: null, generatedResult: f.row().generatedResult }))
      .toBeNull();
  });

  it('does not mark unchanged text as edited or change its revision, timestamps and AI scores', async () => {
    const f = fixture();
    const before = structuredClone(f.row());
    await expect(f.save(0, '原始画面 1')).resolves.toMatchObject({ kind: 'UNCHANGED' });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.row()).toEqual(before);
    expect(f.pending()).toEqual([undefined, undefined]);
  });

  it('retains both consecutive edits, rejects a stale save, and clears only the reverted difference', async () => {
    const f = fixture();
    await expect(f.save(0, '修改后的画面 1')).resolves.toMatchObject({ kind: 'UPDATED' });
    expect(f.pending()).toEqual(['RENDER', undefined]);
    await expect(f.save(1, '修改后的画面 2')).resolves.toMatchObject({ kind: 'UPDATED' });
    expect(f.row().revision).toBe(3);
    expect(f.row().draftResult.items.map((item) => item.content)).toEqual([
      '修改后的画面 1',
      '修改后的画面 2',
    ]);
    expect(Object.keys(f.row().manualOverrides.edited)).toHaveLength(2);
    expect(f.pending()).toEqual(['RENDER', 'RENDER']);
    await expect(f.save(0, '过期请求正文', 1)).resolves.toEqual({ kind: 'REVISION_CONFLICT' });
    expect(f.pending()).toEqual(['RENDER', 'RENDER']);
    await expect(f.save(1, '修改后的画面 2')).resolves.toMatchObject({ kind: 'UNCHANGED' });
    expect(f.row().revision).toBe(3);
    await expect(f.save(0, '原始画面 1')).resolves.toMatchObject({ kind: 'UPDATED' });
    expect(f.pending()).toEqual([undefined, 'RENDER']);
  });
});
