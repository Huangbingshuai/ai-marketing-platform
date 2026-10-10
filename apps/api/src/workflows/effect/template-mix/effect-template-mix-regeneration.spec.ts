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
    clips,
    prompt,
    parent,
    child: () => child,
    snapshot: () => run.inputSnapshot as EffectTemplateMixAiSnapshot,
  };
}

describe('full-template regeneration entry through successful completion', () => {
  it.each(['HOOK', 'PAIN_POINT', 'END'] as const)(
    'append commits real holes after deletion empties %s, without moving other slots',
    async (deletedRole) => {
      const h = harness();
      const deletedSlotId = h
        .child()
        .templates[0]!.workspace.template.slots.find((s) => s.role === deletedRole)!.id;
      const deletedIds = new Set(
        h.clips.filter((clip) => clip.id.startsWith(`${deletedRole}-`)).map((clip) => clip.id),
      );
      const latest = h.clips.filter((clip) => !deletedIds.has(clip.id));
      const added = latest.find((clip) => clip.id === 'PRODUCT-4')!;
      for (const variant of h.child().templates[0]!.workspace.variants) {
        delete variant.bindings[deletedSlotId];
        delete variant.bindingRevisions[deletedSlotId];
        delete variant.offsets[deletedSlotId];
        variant.intentionallyEmptySlotIds = [deletedSlotId];
        variant.preservedTimelineEnd = 48;
      }
      const old = structuredClone(h.child());
      h.repo.sourceArtifacts.mockResolvedValue([h.prompt, ...latest]);
      h.working.listArtifacts.mockResolvedValue({ items: [h.prompt, ...latest] });
      h.repo.listRecent.mockResolvedValue([
        {
          templateId: 't',
          status: 'COMPLETED',
          inputSnapshot: {
            materials: h.clips
              .filter((clip) => clip.id !== added.id)
              .map((clip) => ({ id: clip.id, promptId: clip.payload.promptId })),
          },
        },
      ] as never);
      Object.assign(h.repo, { successfulPackagingTemplateIds: vi.fn().mockResolvedValue(['t']) });
      await h.service.createAiRun('p', 'child', 't', 7, 'sparse-append', undefined, false, true);
      expect(h.snapshot().incremental?.emptySlotPolicy).toBe('ALLOW_EMPTY_POOLS');
      const result = await h.service.classifyAiRun(
        'p',
        'fill-run',
        'lease',
        h.rows.filter((row) => !deletedIds.has(row.materialId)),
      );
      expect(result.selections.every((s) => s.slotId !== deletedSlotId)).toBe(true);
      await h.service.completeAiRun(
        'p',
        'fill-run',
        'lease',
        result.selections.map((s) => ({
          materialId: s.materialId,
          slotId: s.slotId,
          variantIndex: s.variantIndex ?? 0,
          trimStartSeconds: 0,
          trimReason: '冻结素材合法截取',
        })),
      );
      const variants = h.child().templates[0]!.workspace.variants;
      expect(variants.filter((v) => v.id.startsWith('old-'))).toEqual(
        old.templates[0]!.workspace.variants,
      );
      const appended = variants.filter((v) => !v.id.startsWith('old-'));
      expect(appended.length).toBeGreaterThan(0);
      for (const v of appended) {
        expect(v.intentionallyEmptySlotIds).toEqual([deletedSlotId]);
        expect(v.preservedTimelineEnd).toBe(48);
        expect(v.conflictSlotIds).toEqual([]);
        expect(Object.keys(v.bindings)).toHaveLength(5);
        expect(Object.values(v.bindings)).toContain(added.id);
        expect(v.bindingRevisions[deletedSlotId]).toBeUndefined();
        expect(v.offsets[deletedSlotId]).toBeUndefined();
        expect(v.bindingMetadata?.[deletedSlotId]).toBeUndefined();
      }
      expect(h.child().templates[1]).toEqual(old.templates[1]);
    },
  );
  it('keeps APPEND sources and manual roles frozen even when all live clips are subsequently removed', async () => {
    const h = harness();
    const entry = h.child().templates[0]!;
    entry.materialRoleOverrides = { 'END-0': 'END' };
    const operation = {
      protocol: 'FROZEN_RENDER_V1', id: 'operation-1',
      templateHash: workflowStateHash(entry.workspace.template),
      addedMaterialIds: ['HOOK-4'], packageNewVariants: true, facts: [],
      promptArtifacts: [{ id: h.prompt.id, artifactKey: h.prompt.artifactKey,
        revision: h.prompt.revision, contentHash: h.prompt.contentHash }],
      materials: h.clips.map((clip) => ({ id: clip.id, artifactId: clip.id,
        artifactKey: clip.artifactKey, artifactRevision: clip.revision,
        artifactContentHash: clip.contentHash, fileObjectId: clip.payload.fileObjectId,
        contentHash: clip.payload.contentHash, sourcePromptId: clip.payload.promptId,
        promptText: `画面描述 ${h.clips.indexOf(clip)}`, code: clip.name, name: clip.name,
        duration: clip.payload.durationSeconds, ratio: '9:16', resolution: '720p',
        purpose: 'PRODUCT_DISPLAY', compatiblePurposes: [], available: true, activeSource: true,
        contentUrl: `/api/projects/p/file-objects/${clip.payload.fileObjectId}/content` })),
    };
    Object.assign(h.repo, { findOperationRun: vi.fn().mockResolvedValue(null),
      sourceOperation: vi.fn().mockResolvedValue(operation) });
    h.repo.sourceArtifacts.mockResolvedValue([h.prompt] as never);
    h.working.listArtifacts.mockResolvedValue({ items: [h.prompt] } as never);
    await h.service.createAiRun('p', 'child', 't', 7, 'append-frozen', undefined, false, true, operation.id);
    expect(h.snapshot().materials.map(({ fileObjectId }) => fileObjectId))
      .toEqual(operation.materials.map(({ fileObjectId }) => fileObjectId));
    expect(h.snapshot().manualMaterialRoles).toEqual({ 'END-0': 'END' });
    expect(h.snapshot().incremental?.materialIds).toEqual(['HOOK-4']);
    expect(h.snapshot().sourceOperation).toEqual(operation);
    expect(h.snapshot().materials.every(({ adoptedSource }) =>
      !('purpose' in adoptedSource!) && !('compatiblePurposes' in adoptedSource!))).toBe(true);
    expect(h.working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });
  it('reclassifies every current source and resets manual roles only in the successful new batch', async () => {
    const h = harness();
    const entry = h.child().templates[0]!;
    entry.materialRoleOverrides = { 'HOOK-0': 'END', 'HOOK-1': null, obsolete: 'PRODUCT' };
    const original = structuredClone(h.parent);
    h.repo.listRecent.mockResolvedValue([{ templateId: 't', status: 'COMPLETED',
      classificationResult: h.rows, inputSnapshot: { materials: h.clips } }] as never);
    await h.service.createAiRun('p', 'parent', 't', 7, 'reset-all');
    expect(h.snapshot().materialRoleAssignments).toEqual({});
    expect(h.snapshot().manualMaterialRoles).toEqual({});
    expect(h.repo.create.mock.calls[0]![0].initialClassifications ?? []).toEqual([]);
    expect(Object.values(h.snapshot().reuseCounts ?? {}).every((count) => count === 0)).toBe(true);
    expect(entry.materialRoleOverrides).toEqual({ 'HOOK-0': 'END', 'HOOK-1': null, obsolete: 'PRODUCT' });
    const result = await h.service.classifyAiRun('p', 'fill-run', 'lease', h.rows);
    await h.service.completeAiRun('p', 'fill-run', 'lease', result.selections.map((selection) => ({
      materialId: selection.materialId, slotId: selection.slotId, trimStartSeconds: 0, trimReason: '重新选区',
    })));
    expect(h.child().templates[0]!.materialRoleOverrides).toEqual({});
    expect(h.parent).toEqual(original);
  });
  it.each([false, true])('append carries historical manual purpose without old footage (explicit reset: %s)', async (reset) => {
    const h = harness();
    const entry = h.child().templates[0]!;
    entry.materialRoleOverrides = { 'old-end': 'END', ...(reset ? { 'END-0': null } : {}) };
    const end = h.clips.find(({ id }) => id === 'END-0')!;
    const hydrated = h.clips.map((clip) => ({ ...clip, kind: 'FILE', contentUrl: '/video',
      payload: { ...clip.payload, primaryPurpose: 'PRODUCT_DISPLAY' } }));
    h.working.listArtifacts.mockResolvedValue({ items: [h.prompt, ...hydrated,
      { ...end, id: 'old-end', kind: 'FILE', freshness: 'STALE', contentUrl: '/old-video',
        artifactKey: 'render-clip:old-end', payload: { ...end.payload, fileObjectId: 'old-file', primaryPurpose: 'PRODUCT_DISPLAY' } },
    ] } as never);
    h.repo.listRecent.mockResolvedValue([{ templateId: 't', status: 'COMPLETED',
      inputSnapshot: { materials: h.clips.filter(({ id }) => id !== 'HOOK-4')
        .map((clip) => ({ id: clip.id, promptId: clip.payload.promptId })) } }] as never);
    Object.assign(h.repo, { successfulPackagingTemplateIds: vi.fn().mockResolvedValue(['t']) });
    await h.service.createAiRun('p', 'child', 't', 7, 'append-role', undefined, false, true);
    expect(h.snapshot().materials.some(({ id }) => id === 'old-end')).toBe(false);
    expect(h.snapshot().manualMaterialRoles?.['END-0']).toBe(reset ? undefined : 'END');
    expect(h.snapshot().manualMaterialRoles?.['old-end']).toBeUndefined();
    expect(entry.materialRoleOverrides).toEqual({ 'old-end': 'END', ...(reset ? { 'END-0': null } : {}) });
  });
  it.each([false, true])('append ignores a confirmed deleted clip manual purpose without restoring old footage or changing old films (frozen operation: %s)', async (frozen) => {
    const h = harness();
    const entry = h.child().templates[0]!;
    entry.materialRoleOverrides = { 'END-0': 'END' };
    const before = structuredClone(entry);
    const live = h.clips.filter(({ id }) => id !== 'END-0');
    const batch = { id: 'batch', nodeId: 'SEGMENT_RENDER', artifactKey: 'render-batch:b',
      freshness: 'CURRENT', availability: 'AVAILABLE', metadata: {}, payload: {
        clips: live.map((clip) => ({ taskId: clip.artifactKey.slice('render-clip:'.length) })),
        removedSources: [{ taskId: '19', promptId: 'p19' }],
      } };
    h.repo.sourceArtifacts.mockResolvedValue([h.prompt, batch, ...live] as never);
    h.working.listArtifacts.mockResolvedValue({ items: [h.prompt, batch, ...h.clips.map((clip) => ({
      ...clip, kind: 'FILE', contentUrl: '/video',
      payload: { ...clip.payload, primaryPurpose: 'PRODUCT_DISPLAY' },
    }))] } as never);
    h.repo.listRecent.mockResolvedValue([{ templateId: 't', status: 'COMPLETED',
      inputSnapshot: { materials: live.filter(({ id }) => !['HOOK-4', 'TRANSFORMATION-2'].includes(id))
        .map((clip) => ({ id: clip.id, promptId: clip.payload.promptId })) } }] as never);
    Object.assign(h.repo, { successfulPackagingTemplateIds: vi.fn().mockResolvedValue(['t']) });
    if (frozen) Object.assign(h.repo, {
      findOperationRun: vi.fn().mockResolvedValue(null),
      sourceOperation: vi.fn().mockResolvedValue({
        protocol: 'FROZEN_RENDER_V1', id: 'delete-and-add',
        templateHash: workflowStateHash(entry.workspace.template),
        addedMaterialIds: ['HOOK-4', 'TRANSFORMATION-2'], packageNewVariants: true, facts: [],
        promptArtifacts: [{ id: h.prompt.id, artifactKey: h.prompt.artifactKey,
          revision: h.prompt.revision, contentHash: h.prompt.contentHash }],
        materials: live.map((clip) => ({ id: clip.id, artifactId: clip.id,
          artifactKey: clip.artifactKey, artifactRevision: clip.revision,
          artifactContentHash: clip.contentHash, fileObjectId: clip.payload.fileObjectId,
          contentHash: clip.payload.contentHash, sourcePromptId: clip.payload.promptId,
          promptText: `画面描述 ${h.clips.indexOf(clip)}`, code: clip.name, name: clip.name,
          duration: clip.payload.durationSeconds, ratio: '9:16', resolution: '720p',
          purpose: 'PRODUCT_DISPLAY', compatiblePurposes: [], available: true, activeSource: true,
          contentUrl: `/api/projects/p/file-objects/${clip.payload.fileObjectId}/content` })),
      }),
    });
    await h.service.createAiRun('p', 'child', 't', 7, 'append-after-delete', undefined, false, true,
      frozen ? 'delete-and-add' : undefined);
    expect(h.snapshot().materials.some(({ id }) => id === 'END-0')).toBe(false);
    expect(h.snapshot().manualMaterialRoles?.['END-0']).toBeUndefined();
    expect(new Set(h.snapshot().incremental?.materialIds)).toEqual(new Set(['HOOK-4', 'TRANSFORMATION-2']));
    expect(entry).toEqual(before);
    expect(h.working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'too-short'])('append still rejects a %s manual purpose instead of masking it as deletion', async (invalid) => {
    const h = harness();
    h.child().templates[0]!.materialRoleOverrides = invalid === 'foreign'
      ? { foreign: 'END' } : { 'HOOK-0': 'END' };
    if (invalid === 'too-short') h.clips.find(({ id }) => id === 'HOOK-0')!.payload.durationSeconds = 6;
    h.repo.listRecent.mockResolvedValue([{ templateId: 't', status: 'COMPLETED',
      inputSnapshot: { materials: h.clips.filter(({ id }) => id !== 'HOOK-4')
        .map((clip) => ({ id: clip.id, promptId: clip.payload.promptId })) } }] as never);
    await expect(h.service.createAiRun('p', 'child', 't', 7, `reject-${invalid}`, undefined, false, true))
      .rejects.toThrow('不满足');
    expect(h.repo.create).not.toHaveBeenCalled();
  });
  it('append adds only films using new footage, preserves every old slot and commits only new projects', async () => {
    const h = harness();
    const old = structuredClone(h.child());
    const newlyAdded = h.clips.find(({ id }) => id === 'HOOK-4')!;
    h.repo.listRecent.mockResolvedValue([{ templateId: 't', status: 'COMPLETED',
      inputSnapshot: { materials: h.clips.filter(({ id }) => id !== newlyAdded.id)
        .map((clip) => ({ id: clip.id, promptId: clip.payload.promptId })) } }] as never);
    Object.assign(h.repo, { successfulPackagingTemplateIds: vi.fn().mockResolvedValue(['t']) });
    await h.service.createAiRun('p', 'child', 't', 7, 'append', undefined, false, true);
    expect(h.working.beginEffectNodeEdit).not.toHaveBeenCalled();
    expect(h.snapshot().replaceExistingVariants).not.toBe(true);
    expect(h.snapshot()).toMatchObject({
      incremental: { materialIds: [newlyAdded.id], oldVariantIds: old.templates[0]!.workspace.variants.map(({ id }) => id),
        packageNewVariants: true } });
    const result = await h.service.classifyAiRun('p', 'fill-run', 'lease', h.rows);
    await h.service.completeAiRun('p', 'fill-run', 'lease', result.selections.map((selection) => ({
      materialId: selection.materialId, slotId: selection.slotId, variantIndex: selection.variantIndex ?? 0,
      trimStartSeconds: 0, trimReason: '新增素材保留完整动作',
    })));
    const variants = h.child().templates[0]!.workspace.variants;
    expect(variants.filter(({ id }) => id.startsWith('old-'))).toEqual(old.templates[0]!.workspace.variants);
    const added = variants.filter(({ id }) => !id.startsWith('old-'));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((variant) => Object.values(variant.bindings).includes(newlyAdded.id) &&
      variant.slots.length === 6 && Object.keys(variant.bindings).length === 6)).toBe(true);
    expect(h.child().templates[1]).toEqual(old.templates[1]);
    const committed = h.working.commitValidatedArtifacts.mock.calls[0]![3];
    expect(committed.filter((item: { artifactKey: string }) => item.artifactKey.startsWith('timeline-project:'))
      .map((item: { artifactKey: string }) => item.artifactKey)).toEqual(
        expect.arrayContaining(added.map(({ id }) => `timeline-project:t:${id}`)));
    expect(committed.some((item: { artifactKey: string }) => item.artifactKey.includes(':old-'))).toBe(false);
    expect(h.working.publishEffectNodeEdit).not.toHaveBeenCalled();
  });
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
