import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSnapshot,
  EffectTemplateMixDraft,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import type { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { EffectTemplateMixService } from './effect-template-mix.service';

const roles = ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'] as const;
function harness(oldCount = 3) {
  const counts = [5, 1, 5, 5, 3, 1];
  const slots = roles.map((role, index) => ({
    id: `s${index}`,
    role,
    label: role,
    purpose: 'HOOK' as const,
    duration: [4, 10, 10, 10, 6, 8][index]!,
    transition: '硬切' as const,
  }));
  const rows: EffectTemplateMixAiClassification[] = roles.flatMap((role, index) =>
    Array.from({ length: counts[index]! }, (_, number) => ({
      materialId: `${role}-${number}`,
      scores: Object.fromEntries(
        roles.map((candidate) => [candidate, Number(candidate === role)]),
      ) as EffectTemplateMixAiClassification['scores'],
      reasons: {},
    })),
  );
  const clips = rows.map((row, index) => ({
    id: row.materialId,
    workflowRunId: 'child',
    nodeId: 'SEGMENT_RENDER',
    artifactKey: `render-clip:${index}`,
    revision: 1,
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
    storageKey: `video/${index}.mp4`,
    contentHash: 'a'.repeat(64),
    name: row.materialId,
    metadata: {},
    payload: {
      promptId: `p${index}`,
      durationSeconds: 10,
      fileObjectId: `file-${index}`,
      contentHash: 'b'.repeat(64),
    },
  }));
  const prompt = {
    id: 'prompts',
    nodeId: 'PROMPT_GENERATION',
    artifactKey: 'prompt-batch:p',
    revision: 1,
    contentHash: 'c'.repeat(64),
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
    payload: { items: rows.map((_, index) => ({ id: `p${index}`, content: `画面描述 ${index}` })) },
  };
  const variants = Array.from({ length: oldCount }, (_, index) => ({
    id: `old-${index}`,
    name: `旧工程 ${index}`,
    appliedTemplateVersion: 1,
    slots,
    bindings: Object.fromEntries(roles.map((role, slot) => [`s${slot}`, `${role}-0`])),
    bindingRevisions: Object.fromEntries(slots.map((slot) => [slot.id, 1])),
    offsets: Object.fromEntries(slots.map((slot) => [slot.id, 0])),
    manualSlotIds: [],
    conflictSlotIds: [],
    status: 'CURRENT' as const,
    captions: [],
    subtitleStyle: 'standard' as const,
    bgm: null,
    voice: null,
    originalVolume: 1,
  }));
  const parent: EffectTemplateMixDraft = {
    schemaVersion: 1,
    activeTemplateId: 't',
    templates: [
      {
        id: 't',
        workspace: { editVersion: 1, template: { name: '测试3', editVersion: 1, slots }, variants },
      },
      {
        id: 'other',
        workspace: {
          editVersion: 1,
          template: { name: '别的模板', editVersion: 1, slots },
          variants: variants.slice(0, 1),
        },
      },
    ],
  };
  let child = structuredClone(parent),
    revision = 7;
  const now = new Date('2026-10-06T08:00:00Z');
  let run: Record<string, unknown>;
  const working = {
    getNodeState: vi
      .fn()
      .mockImplementation(async (_project, scope) => ({
        revision,
        state: structuredClone(scope === 'parent' ? parent : child),
      })),
    beginEffectNodeEdit: vi
      .fn()
      .mockResolvedValue({ run: { id: 'child' }, created: true, parentWorkflowRunId: 'parent' }),
    listArtifacts: vi.fn().mockResolvedValue({ items: [prompt, ...clips] }),
    commitValidatedArtifacts: vi.fn().mockResolvedValue([]),
    publishEffectNodeEdit: vi.fn().mockResolvedValue({}),
  };
  const repo = {
    sourceArtifacts: vi.fn().mockResolvedValue([prompt, ...clips]),
    listRecent: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async (input) => {
      run = {
        id: 'fill-run',
        templateId: 't',
        workflowRunId: 'child',
        targetVariantId: input.targetVariantId,
        status: 'RUNNING',
        stage: 'CLASSIFYING',
        progress: 0,
        attemptToken: 'lease',
        inputSnapshot: input.snapshot,
        createdAt: now,
        updatedAt: now,
      };
      return { kind: 'CREATED', run };
    }),
    find: vi.fn().mockImplementation(async () => run),
    saveSelection: vi.fn().mockImplementation(async (_p, _r, _a, classifications, selections) => {
      run.classificationResult = classifications;
      run.selectionResult = selections;
      return { count: 1 };
    }),
    completeWithDraft: vi
      .fn()
      .mockImplementation(async (_p, _r, _a, outputVariantId, _trims, draft) => {
        child = structuredClone(draft);
        revision++;
        run.status = 'COMPLETED';
        run.outputVariantId = outputVariantId;
        return 'COMPLETED';
      }),
  };
  const service = new EffectTemplateMixService(
    working as unknown as WorkflowWorkingService,
    repo as unknown as EffectTemplateMixAiRepository,
  );
  return {
    service,
    repo,
    working,
    rows,
    parent,
    child: () => child,
    snapshot: () => run.inputSnapshot as EffectTemplateMixAiSnapshot,
  };
}

describe('full-template regeneration entry through successful completion', () => {
  it('regenerates 13 fresh projects covering 20 clips, rather than refilling one or appending to three', async () => {
    const h = harness();
    const original = structuredClone(h.parent);
    await h.service.createAiRun('p', 'parent', 't', 7, 'request');
    expect(h.working.beginEffectNodeEdit).toHaveBeenCalledWith(
      'p',
      'parent',
      'TEMPLATE_MIX',
      'BATCH',
      expect.objectContaining({ always: true, keepParentActive: true }),
    );
    expect(h.snapshot()).toMatchObject({
      targetVariantId: null,
      maxOutputVariants: 100,
      replaceExistingVariants: true,
      requireAllMaterials: true,
      existingVariantBindings: [],
    });
    expect(h.snapshot().workspaceHash).toBe(workflowStateHash(original.templates[0]!.workspace));
    const result = await h.service.classifyAiRun('p', 'fill-run', 'lease', h.rows);
    expect(result.selections).toHaveLength(20);
    const trims = result.selections.map((selection) => ({
      materialId: selection.materialId,
      slotId: selection.slotId,
      trimStartSeconds: 0,
      trimReason: '保持完整动作',
    }));
    await h.service.completeAiRun('p', 'fill-run', 'lease', trims);
    const generated = h.child().templates[0]!.workspace.variants;
    expect(generated).toHaveLength(13);
    expect(generated.every((variant) => !variant.id.startsWith('old-'))).toBe(true);
    expect(new Set(generated.flatMap((variant) => Object.values(variant.bindings))).size).toBe(20);
    for (const variant of generated)
      for (const slot of variant.slots)
        expect(variant.bindings[slot.id]).toMatch(new RegExp(`^${slot.role}-`));
    expect(h.parent).toEqual(original);
    expect(h.child().templates[1]).toEqual(original.templates[1]);
    const committed = h.working.commitValidatedArtifacts.mock.calls[0]![3];
    expect(
      committed.filter((item: { artifactKey: string }) =>
        item.artifactKey.startsWith('timeline-project:'),
      ),
    ).toHaveLength(13);
  });

  it('does not let 100 inherited projects consume the new full-batch capacity', async () => {
    const h = harness(100);
    await h.service.createAiRun('p', 'parent', 't', 7, 'request');
    expect(h.snapshot().maxOutputVariants).toBe(100);
    const result = await h.service.classifyAiRun('p', 'fill-run', 'lease', h.rows);
    await h.service.completeAiRun(
      'p',
      'fill-run',
      'lease',
      result.selections.map((selection) => ({
        slotId: selection.slotId,
        materialId: selection.materialId,
        trimStartSeconds: 0,
        trimReason: '完整',
      })),
    );
    expect(h.child().templates[0]!.workspace.variants).toHaveLength(13);
    expect(h.parent.templates[0]!.workspace.variants).toHaveLength(100);
  });

  it('leaves both batches intact if trim validation fails', async () => {
    const h = harness();
    await h.service.createAiRun('p', 'parent', 't', 7, 'request');
    await h.service.classifyAiRun('p', 'fill-run', 'lease', h.rows);
    await expect(h.service.completeAiRun('p', 'fill-run', 'lease', [])).rejects.toThrow(
      '截取区间无效',
    );
    expect(h.repo.completeWithDraft).not.toHaveBeenCalled();
    expect(h.parent.templates[0]!.workspace.variants).toHaveLength(3);
    expect(h.child().templates[0]!.workspace.variants).toHaveLength(3);
  });
});
