import type {
  EffectTemplateMixDraft,
  EffectTemplateMixVariant,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { templateConfigurationHash } from './template-mix-lifecycle';

const templateId = '3c2504a0-b21a-4a7d-b486-14495c73bdf4';
const variantId = '01795c3c-4726-405b-bbc9-28137f768fff';
const slotId = 'e169b2ee-0ee7-4f03-88cf-25d85218691f';
const sourceId = '7b084c93-e637-430a-812f-d0e277e41804';

const draft = (): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  activeTemplateId: templateId,
  templates: [
    {
      id: templateId,
      workspace: {
        editVersion: 4,
        template: {
          name: '跑量模板',
          editVersion: 2,
          slots: [
            {
              id: slotId,
              label: '片头钩子',
              role: 'HOOK',
              purpose: 'HOOK',
              duration: 4,
              transition: '硬切',
            },
          ],
        },
        variants: [
          {
            id: variantId,
            name: '跑量模板 · 1',
            appliedTemplateVersion: 2,
            slots: [
              {
                id: slotId,
                label: '片头钩子',
                role: 'HOOK',
                purpose: 'HOOK',
                duration: 4,
                transition: '硬切',
              },
            ],
            bindings: { [slotId]: sourceId },
            bindingRevisions: { [slotId]: 2 },
            offsets: { [slotId]: 0 },
            manualSlotIds: [],
            conflictSlotIds: [],
            status: 'CURRENT',
            captions: [],
            subtitleStyle: 'standard',
            bgm: null,
            voice: null,
            originalVolume: 1,
          },
        ],
      },
    },
  ],
});

const source = {
  id: sourceId,
  nodeId: 'SEGMENT_RENDER',
  artifactKey: 'render-clip:task-1',
  kind: 'FILE',
  name: '钩子视频片段',
  contentUrl: '/api/projects/project/workflow-artifacts/' + sourceId + '/content',
  revision: 2,
  availability: 'AVAILABLE',
  freshness: 'CURRENT',
  payload: {
    durationSeconds: 4,
    contentHash: 'sha',
    fileObjectId: 'file-1',
    primaryPurpose: 'HOOK',
    compatiblePurposes: [],
  },
} as WorkingArtifact;

const harness = () => {
  const working = {
    // A fill with no published version to protect stays in the Run it was asked for.
    beginEffectNodeEdit: vi.fn().mockResolvedValue({
      run: { id: 'run' },
      parentWorkflowRunId: null,
      productIdMap: {},
      taskIdMap: {},
      created: false,
    }),
    getNodeState: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
    getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
    listArtifacts: vi.fn().mockResolvedValue({ items: [source], total: 1 }),
    putNodeState: vi.fn().mockImplementation((_project, _run, _node, input) =>
      Promise.resolve({
        nodeState: { revision: 8, state: input.state },
        unchanged: false,
      }),
    ),
    commitValidatedArtifacts: vi.fn().mockResolvedValue([
      {
        artifact: { id: templateId, artifactKey: 'mix-template:' + templateId, revision: 1 },
        unchanged: false,
      },
      {
        artifact: {
          id: variantId,
          artifactKey: 'timeline-project:' + templateId + ':' + variantId,
          revision: 1,
        },
        unchanged: false,
      },
    ]),
    publishEffectNodeEdit: vi.fn().mockResolvedValue({
      run: { id: 'run' },
      activeWorkflowRunId: 'run',
      createdBranch: false,
    }),
  };
  return {
    working,
    service: new EffectTemplateMixService(working as unknown as WorkflowWorkingService),
  };
};

describe('EffectTemplateMixService', () => {
  it('deletes only the requested project and allows an empty template without touching versions', async () => {
    const { service, working } = harness();
    const value = draft();
    const other = structuredClone(value.templates[0]!);
    other.id = 'other-template';
    value.templates.push(other);
    working.getNodeState.mockResolvedValue({ revision: 7, state: value });
    const result = await service.deleteVariant('project', 'run', templateId, variantId, 7);
    expect(result.draft.templates[0]!.workspace.variants).toEqual([]);
    expect(result.draft.templates[0]!.workspace.editVersion).toBe(5);
    expect(result.draft.templates[1]!.workspace.variants).toHaveLength(1);
    expect(working.putNodeState).toHaveBeenCalledWith('project', 'run', 'TEMPLATE_MIX',
      expect.objectContaining({ expectedRevision: 7 }));
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('rejects unknown projects and stale deletion revisions without saving', async () => {
    const { service, working } = harness();
    await expect(service.deleteVariant('project', 'run', templateId, 'foreign-variant', 7))
      .rejects.toThrow('当前成片工程不存在');
    await expect(service.deleteVariant('project', 'run', templateId, variantId, 6))
      .rejects.toThrow('混剪草稿已在其他页面更新');
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('returns only the persisted revision for compact autosave without rebuilding the workbench', async () => {
    const { working } = harness();
    const aiRuns = {
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      inheritedMixAiRuns: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'HOOK' };
    await expect(service.saveDraft('project', 'run', 7, value, true))
      .resolves.toEqual({ draftRevision: 8 });
    expect(working.putNodeState).toHaveBeenCalledOnce();
    expect(working.putNodeState.mock.calls[0]![3].state.templates[0]).toMatchObject({
      materialRoleOverrides: { [sourceId]: 'HOOK' }, materialRoleEditVersion: 1,
    });
    expect(aiRuns.listRecent).toHaveBeenCalledOnce(); // Lock/source validation still runs.
    expect(aiRuns.sourceArtifacts).not.toHaveBeenCalled();
    expect(aiRuns.inheritedMixAiRuns).not.toHaveBeenCalled();
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('does not bypass material ownership validation for compact autosave', async () => {
    const { service, working } = harness();
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { 'foreign-source': 'HOOK' };
    await expect(service.saveDraft('project', 'run', 7, value, true)).rejects.toThrow();
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('projects output sources through the existing artifact reader without loading workbench history', async () => {
    const { service, working } = harness();
    const result = await service.outputSourceWorkspace('project', 'run');
    expect(result.draft).toEqual(draft());
    expect(result.materials).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceId, artifactRevision: 2, fileObjectId: 'file-1', available: true }),
    ]));
    expect(working.getNodeStateOrNull).toHaveBeenCalledWith('project', 'run', 'TEMPLATE_MIX');
    expect(result.artifacts).toEqual([source]);
    expect(working.listArtifacts).toHaveBeenCalledExactlyOnceWith('project', { workflowRunId: 'run' });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });
  it('reads only the draft when pending output needs a name rather than source differences', async () => {
    const { service, working } = harness();
    const result = await service.outputSourceWorkspace('project', 'run', false);
    expect(result.draft).toEqual(draft());
    expect(result.materials).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(working.listArtifacts).not.toHaveBeenCalled();
  });
  it('keeps bound clips for playback but excludes retired clips from the live source pool', async () => {
    const { service, working } = harness();
    const replacement = { ...source, id: 'replacement', artifactKey: 'render-clip:new-task',
      payload: { ...(source.payload as Record<string, unknown>), fileObjectId: 'file-new' } };
    const batch = { ...source, id: 'batch', kind: 'STRUCTURED', artifactKey: 'render-batch:pool',
      payload: { clips: [{ taskId: 'new-task' }] } } as WorkingArtifact;
    working.listArtifacts.mockResolvedValue({ items: [source, replacement, batch], total: 3 });
    const result = await service.outputSourceWorkspace('project', 'run');
    expect(result.materials.find((material) => material.id === source.id)).toMatchObject({ activeSource: false });
    expect(result.materials.find((material) => material.id === replacement.id)).toMatchObject({ activeSource: true });
    expect((await service.materialSources('project', 'run')).pendingProjectCount).toBe(1);
    expect(result.draftRevision).toBe(7);
    batch.payload = { clips: [] };
    const empty = await service.outputSourceWorkspace('project', 'run');
    expect(empty.materials.filter((material) => material.activeSource)).toEqual([]);
    expect(empty.materials.find((material) => material.id === source.id)?.available).toBe(true);
  });
  it('autosaves material roles without confirming artifacts or changing timeline content', async () => {
    const { service, working } = harness();
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'HOOK' };
    const result = await service.saveDraft('project', 'run', 7, value);
    expect(result.draft.templates[0]!.materialRoleOverrides).toEqual({ [sourceId]: 'HOOK' });
    expect(result.draft.templates[0]!.materialRoleEditVersion).toBe(1);
    expect(result.draft.templates[0]!.workspace).toEqual(draft().templates[0]!.workspace);
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
    expect(working.beginEffectNodeEdit).not.toHaveBeenCalled();
  });

  it('freezes manual roles for smart-fill and enforces them in role pools', async () => {
    const { working } = harness();
    const state = draft();
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const entry = state.templates[0]!;
    entry.workspace.variants = [];
    entry.workspace.template.slots = roles.map((role) => ({
      ...entry.workspace.template.slots[0]!,
      id: role,
      role,
    }));
    entry.materialRoleOverrides = { 'clip-0': 'PRODUCT', 'clip-1': null };
    entry.materialRoleEditVersion = 2;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    const prompt = {
      ...source,
      id: 'prompt-batch',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:p',
      contentHash: 'prompt-hash',
      payload: { items: roles.map((_, index) => ({ id: `p${index}`, content: '原始产品画面' })) },
    };
    const clips = roles.map((_, index) => ({
      ...source,
      id: `clip-${index}`,
      artifactKey: `render-clip:${index}`,
      contentHash: `hash-${index}`,
      storageKey: `video-${index}`,
      payload: {
        ...(source.payload as object),
        promptId: `p${index}`,
        fileObjectId: `file-${index}`,
      },
    }));
    const create = vi
      .fn()
      .mockResolvedValue({
        kind: 'CREATED',
        run: {
          id: 'ai',
          templateId,
          workflowRunId: 'run',
          targetVariantId: null,
          outputVariantId: null,
          status: 'QUEUED',
          stage: 'CLASSIFYING',
          progress: 0,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    const repository = {
      sourceArtifacts: vi.fn().mockResolvedValue([prompt, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      create,
      find: vi.fn(),
      saveSelection: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );
    await service.createAiRun('project', 'run', templateId, 7, 'key');
    const input = create.mock.calls[0]![0];
    expect(input.snapshot.materialRoleAssignments).toEqual({ 'clip-0': 'PRODUCT' });
    expect(input.snapshot.manualMaterialRoles).toEqual({ 'clip-0': 'PRODUCT' });
    expect(input.initialClassifications).toHaveLength(1);
    expect(input.initialClassifications[0]).toMatchObject({
      materialId: 'clip-0',
      source: 'MANUAL',
    });
    entry.materialRoleOverrides['clip-0'] = 'END';
    expect(input.snapshot.materialRoleAssignments['clip-0']).toBe('PRODUCT');
    repository.find.mockResolvedValue({
      status: 'RUNNING',
      attemptToken: 'attempt',
      inputSnapshot: input.snapshot,
    });
    const rows = roles.map((role, index) => ({
      materialId: `clip-${index}`,
      scores: Object.fromEntries(roles.map((candidate) => [candidate, candidate === role ? 1 : 0])),
      reasons: {},
    }));
    rows[0] = input.initialClassifications[0];
    rows[2]!.scores.HOOK = 0.8;
    const result = await service.classifyAiRun('project', 'ai', 'attempt', rows as never);
    expect(result.selections.find((item) => item.materialId === 'clip-0')?.role).toBe('PRODUCT');
    await expect(
      service.classifyAiRun(
        'project',
        'ai',
        'attempt',
        rows.map((row) => ({ ...row, source: 'AI' })) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each(['foreign-id', 'stale-id'])(
    'rejects assigning a %s material from outside the current pool',
    async (id) => {
      const { service, working } = harness();
      working.listArtifacts.mockResolvedValue({
        items: [source, { ...source, id: 'stale-id', freshness: 'STALE' }],
        total: 2,
      });
      const value = draft();
      value.templates[0]!.materialRoleOverrides = { [id]: 'HOOK' };
      await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
        status: 400,
      });
      expect(working.putNodeState).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown roles and too-short manually assigned materials', async () => {
    const { service } = harness();
    const value = draft();
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'UNKNOWN' as 'HOOK' };
    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
    value.templates[0]!.materialRoleOverrides = { [sourceId]: 'HOOK' };
    value.templates[0]!.workspace.template.slots[0]!.duration = 5;
    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
  });
  it('uses only the committed render batch for the cap, not longer clips left in the library', async () => {
    const { service, working } = harness();
    const current = {
      ...source,
      payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 8 },
    };
    const leftover = {
      ...current,
      id: 'leftover',
      artifactKey: 'render-clip:older-task',
      payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 15 },
    };
    const batch = {
      ...source,
      id: 'batch',
      kind: 'STRUCTURED',
      artifactKey: 'render-batch:product',
      payload: { clips: [{ taskId: 'task-1' }] },
    };
    working.listArtifacts.mockResolvedValue({
      items: [current, leftover, batch] as WorkingArtifact[],
      total: 3,
    });
    const value = draft();
    value.templates[0]!.workspace.template.slots[0]!.duration = 8;
    const result = await service.saveDraft('project', 'run', 7, value);
    expect(result.slotDurationMaxSeconds).toBe(8);
    value.templates[0]!.workspace.template.slots[0]!.duration = 9;
    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
  });
  it.each([8, 10, 15])(
    'accepts the frozen %s-second upper boundary and rejects an out-of-range draft',
    async (maximum) => {
      const { service, working } = harness();
      const current = {
        ...source,
        payload: { ...(source.payload as Record<string, unknown>), durationSeconds: maximum },
      };
      const stale = {
        ...source,
        id: 'old-long-clip',
        artifactKey: 'render-clip:old',
        freshness: 'STALE',
        payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 20 },
      };
      working.listArtifacts.mockResolvedValue({
        items: [current, stale] as WorkingArtifact[],
        total: 2,
      });
      const value = draft();
      value.templates[0]!.workspace.template.slots[0]!.duration = maximum;
      await expect(service.saveDraft('project', 'run', 7, value)).resolves.toBeDefined();
      working.putNodeState.mockClear();
      value.templates[0]!.workspace.template.slots[0]!.duration = maximum + 0.1;
      await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
        status: 400,
      });
      expect(working.putNodeState).not.toHaveBeenCalled();
      value.templates[0]!.workspace.template.slots[0]!.duration = 3.9;
      await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
        status: 400,
      });
    },
  );

  it('preserves an untouched historical long slot but refuses generating new projects from it', async () => {
    const { service, working } = harness();
    const previous = draft();
    previous.templates[0]!.workspace.template.slots[0]!.duration = 15;
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const edited = structuredClone(previous);
    edited.templates[0]!.workspace.template.name = '仅修改名称';
    await expect(service.saveDraft('project', 'run', 7, edited)).resolves.toBeDefined();
    working.getNodeState.mockResolvedValue({ revision: 7, state: previous });
    await expect(service.createEmptyVariant('project', 'run', templateId, 7)).rejects.toMatchObject(
      { status: 400 },
    );
  });
  it('reads only the saved variant for packaging hot-path source checks', async () => {
    const { service, working } = harness();
    expect((await service.currentVariant('project', 'run', templateId, variantId))?.id).toBe(
      variantId,
    );
    expect(working.getNodeStateOrNull).toHaveBeenCalledWith('project', 'run', 'TEMPLATE_MIX');
    expect(working.listArtifacts).not.toHaveBeenCalled();
    expect(await service.currentVariant('project', 'run', templateId, 'missing')).toBeNull();
    working.getNodeStateOrNull.mockResolvedValue(null);
    expect(await service.currentVariant('project', 'run', templateId, variantId)).toBeNull();
  });
  it('projects persisted stage shard counts and a few real inputs and outputs', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const inputSnapshot = {
      materials: Array.from({ length: 5 }, (_, index) => ({
        id: `material-${index + 1}`,
        code: `R-${index + 1}`,
        name: `素材 ${index + 1}`,
        duration: 15,
        promptSummary:
          index === 0 ? '木勺将刚出锅的酱汁淋在脆皮鸡块上，突出酥脆与多汁口感' : undefined,
      })),
      template: { name: '跑量模板', slots: [{ id: slotId, label: '片头钩子', duration: 4 }] },
    };
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: 'run-id',
        templateId,
        targetVariantId: null,
        outputVariantId: null,
        status: 'RUNNING',
        stage: 'CLASSIFYING',
        progress: 45,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        inputSnapshot,
        classificationResult: [
          {
            materialId: 'material-1',
            scores: { HOOK: 0.91, PAIN_POINT: 0.2, PRODUCT: 0.8 },
            reasons: { HOOK: '酱汁淋下的动作开场醒目，能快速抓住注意力' },
          },
          { materialId: 'material-2', scores: { HOOK: 0.4 }, reasons: { HOOK: '画面信息较少' } },
          {
            materialId: 'material-3',
            scores: { PRODUCT: 0.75 },
            reasons: { PRODUCT: '主体产品清晰' },
          },
        ],
        selectionResult: [
          {
            materialId: 'material-1',
            slotId,
            role: 'HOOK',
            matchScore: 0.91,
            matchLevel: 'NORMAL',
            classificationReason: '酱汁淋下的开场动作最醒目',
            duration: 4,
          },
          {
            materialId: 'material-2',
            slotId,
            role: 'HOOK',
            matchScore: 0.4,
            matchLevel: 'LOW_MATCH',
            classificationReason: '缺少更合适的钩子素材',
            duration: 4,
          },
        ],
        samplingResult: [{ materialId: 'material-1', frameTimestampsSeconds: [0, 1.2, 3.8] }],
        trimResult: [
          {
            materialId: 'material-1',
            slotId,
            trimStartSeconds: 1.25,
            trimReason: '勺子落下并带出酱汁的瞬间，产品状态最清楚',
          },
        ],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    const run = await service.aiRun('project', 'run-id');

    expect(run.stageDetails?.CLASSIFYING).toMatchObject({ completed: 3, total: 5 });
    expect(run.stageDetails?.CLASSIFYING?.inputSamples[0]).toContain(
      '创意主线：木勺将刚出锅的酱汁',
    );
    expect(run.stageDetails?.CLASSIFYING?.outputSamples[0]).toContain('片头钩子 91%');
    expect(run.stageDetails?.CLASSIFYING?.outputSamples[0]).toContain('快速抓住注意力');
    expect(run.stageDetails?.MATCHING).toMatchObject({ completed: 1, total: 1 });
    expect(run.stageDetails?.MATCHING?.outputSamples[0]).toContain('匹配度 91%');
    expect(run.stageDetails?.MATCHING?.outputSamples[1]).toContain('备选补位');
    expect(run.stageDetails?.SAMPLING).toMatchObject({ completed: 1, total: 2 });
    expect(run.stageDetails?.SAMPLING?.outputSamples[0]).toContain(
      '抽取 3 张关键帧（0.0 秒、1.2 秒、3.8 秒）',
    );
    expect(run.stageDetails?.TRIMMING?.outputSamples[0]).toContain('截取 1.3–5.3 秒');
    expect(run.stageDetails?.TRIMMING?.outputSamples[0]).toContain('勺子落下并带出酱汁');
    expect(run.stageDetails?.COMPLETED).toMatchObject({ completed: 0, total: 1 });
  });

  it('uses completed trim results as proof of frame extraction for historical runs', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: 'run-id',
        templateId,
        targetVariantId: null,
        outputVariantId: null,
        status: 'COMPLETED',
        stage: 'COMPLETED',
        progress: 100,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        inputSnapshot: {
          materials: [{ id: 'material-1', code: 'R-1', name: '钩子镜头', duration: 15 }],
          template: { name: '跑量模板', slots: [{ id: slotId, label: '片头钩子', duration: 4 }] },
        },
        classificationResult: [],
        selectionResult: [
          { materialId: 'material-1', slotId, role: 'HOOK', variantIndex: 0, duration: 4 },
        ],
        samplingResult: [],
        trimResult: [
          { materialId: 'material-1', slotId, trimStartSeconds: 2, trimReason: '动作完整' },
        ],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );
    const run = await service.aiRun('project', 'run-id');
    expect(run.stageDetails?.SAMPLING).toMatchObject({ completed: 1, total: 1 });
    expect(run.stageDetails?.SAMPLING?.outputSamples[0]).toContain('旧任务记录由截取结果确认');
  });

  it('counts frame extraction by distinct source videos rather than repeated timeline placements', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: 'run-id',
        templateId,
        targetVariantId: null,
        outputVariantId: null,
        status: 'RUNNING',
        stage: 'SAMPLING',
        progress: 55,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        inputSnapshot: {
          materials: [{ id: 'material-1', code: 'R-1', name: '钩子镜头', duration: 15 }],
          template: { slots: [{ id: slotId, label: '片头钩子', duration: 4 }] },
        },
        selectionResult: [
          { materialId: 'material-1', slotId, variantIndex: 0, role: 'HOOK', duration: 4 },
          { materialId: 'material-1', slotId, variantIndex: 1, role: 'HOOK', duration: 4 },
        ],
        samplingResult: [{ materialId: 'material-1', frameTimestampsSeconds: [0.2, 1.5] }],
        classificationResult: [],
        trimResult: [],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );
    const run = await service.aiRun('project', 'run-id');
    expect(run.stageDetails?.SAMPLING).toMatchObject({ completed: 1, total: 1 });
  });

  it('preserves untouched legacy 3-second slots while rejecting newly edited ones', async () => {
    const { service, working } = harness();
    const legacy = draft();
    legacy.templates[0]!.workspace.template.slots[0]!.duration = 3;
    legacy.templates[0]!.workspace.variants[0]!.slots[0]!.duration = 3;
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: legacy });
    const unchanged = JSON.parse(JSON.stringify(legacy)) as EffectTemplateMixDraft;
    unchanged.templates[0]!.workspace.template.name = '更新名称';
    await expect(service.saveDraft('project', 'run', 7, unchanged)).resolves.toBeDefined();
    unchanged.templates[0]!.workspace.template.slots[0]!.label = '新钩子';
    await expect(service.saveDraft('project', 'run', 7, unchanged)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('allows the first 4-second draft without a previous node state', async () => {
    const { service, working } = harness();
    working.getNodeStateOrNull.mockResolvedValue(null);
    const saved = await service.saveDraft('project', 'run', null, draft());
    const createdAt = saved.draft.templates[0]?.createdAt;
    expect(createdAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(createdAt!))).toBe(false);

    const edited = draft();
    edited.templates[0]!.createdAt = '2000-01-01T00:00:00.000Z';
    working.getNodeStateOrNull.mockResolvedValue({ revision: 8, state: saved.draft });
    await service.saveDraft('project', 'run', 8, edited);
    expect(working.putNodeState.mock.calls[1]?.[3].state.templates[0]?.createdAt).toBe(createdAt);
  });

  it('rejects a new template while the render batch has not succeeded', async () => {
    const { service, working } = harness();
    working.getNodeStateOrNull.mockResolvedValue(null);
    working.listArtifacts.mockResolvedValue({ items: [], total: 0 });

    await expect(service.saveDraft('project', 'run', null, draft())).rejects.toMatchObject({
      status: 409,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
    expect((await service.workspace('project', 'run')).templateCreationReady).toBe(false);
  });

  it('allows a new template after the render batch succeeds, before render validation', async () => {
    const { working } = harness();
    working.getNodeStateOrNull.mockResolvedValue(null);
    working.listArtifacts.mockResolvedValue({ items: [], total: 0 });
    const repository = {
      hasSuccessfulRenderBatch: vi.fn().mockResolvedValue(true),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      packagedTemplateIds: vi.fn().mockResolvedValue([]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    const saved = await service.saveDraft('project', 'run', null, draft());
    expect(saved.templateCreationReady).toBe(true);
    expect(working.putNodeState).toHaveBeenCalledOnce();
  });

  it('deletes an unfilled template from the draft after checking its downstream records', async () => {
    const { working } = harness();
    const repository = {
      templateHasDownstream: vi.fn().mockResolvedValue(false),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      packagedTemplateIds: vi.fn().mockResolvedValue([]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    const saved = await service.saveDraft('project', 'run', 7, {
      schemaVersion: 1,
      activeTemplateId: '',
      templates: [],
    });

    expect(repository.templateHasDownstream).toHaveBeenCalledWith('project', 'run', templateId);
    expect(saved.draft.templates).toEqual([]);
    expect(saved.draft.activeTemplateId).toBe('');
    expect(working.putNodeState).toHaveBeenCalledOnce();
  });

  it('refuses to delete a template that already has smart-fill or a downstream branch', async () => {
    const { working } = harness();
    const repository = {
      templateHasDownstream: vi.fn().mockResolvedValue(true),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      packagedTemplateIds: vi.fn().mockResolvedValue([]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.saveDraft('project', 'run', 7, {
        schemaVersion: 1,
        activeTemplateId: '',
        templates: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(repository.templateHasDownstream).toHaveBeenCalledWith('project', 'run', templateId);
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('does not invent a creation time for a legacy template or trust a client replacement', async () => {
    const { service, working } = harness();
    const edited = draft();
    edited.templates[0]!.createdAt = '2000-01-01T00:00:00.000Z';
    const saved = await service.saveDraft('project', 'run', 7, edited);
    expect(saved.draft.templates[0]?.createdAt).toBeUndefined();
    expect(working.putNodeState.mock.calls[0]?.[3].state.templates[0]?.createdAt).toBeUndefined();
  });

  it('rejects an invalid template creation timestamp', async () => {
    const { service, working } = harness();
    const edited = draft();
    edited.templates[0]!.createdAt = 'not-a-date';
    await expect(service.saveDraft('project', 'run', 7, edited)).rejects.toMatchObject({
      status: 400,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('rejects newly introduced duplicate template names after whitespace and Unicode normalization', async () => {
    const { service, working } = harness();
    const value = draft();
    const duplicate = JSON.parse(
      JSON.stringify(value.templates[0]),
    ) as (typeof value.templates)[number];
    duplicate.id = 'another-template';
    duplicate.workspace.template.name = '　跑量模板　';
    value.templates.push(duplicate);

    await expect(service.saveDraft('project', 'run', 7, value)).rejects.toMatchObject({
      status: 400,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('saves template changes after fill and marks them as needing a new fill', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 8 },
        },
      ],
      total: 1,
    });
    const value = draft();
    value.templates[0]!.filledTemplateHash = templateConfigurationHash(
      value.templates[0]!.workspace.template,
    );
    value.templates[0]!.workspace.template.slots[0]!.duration = 5;
    working.getNodeStateOrNull.mockResolvedValue({
      revision: 7,
      state: {
        ...value,
        templates: [
          {
            ...value.templates[0]!,
            workspace: {
              ...value.templates[0]!.workspace,
              template: {
                ...value.templates[0]!.workspace.template,
                slots: [{ ...value.templates[0]!.workspace.template.slots[0]!, duration: 4 }],
              },
            },
          },
        ],
      },
    });
    const result = await service.saveDraft('project', 'run', 7, value);
    expect(working.putNodeState).toHaveBeenCalledOnce();
    expect(result.draft.templates[0]?.needsAiFill).toBe(true);
  });

  it('commits a template and timeline with the exact consumed clip revision', async () => {
    const { service, working } = harness();
    const result = await service.validate('project', 'run', 7, templateId);
    expect(result.artifacts).toHaveLength(2);
    const inputs = working.commitValidatedArtifacts.mock.calls[0]![3];
    expect(inputs[1].input.dependencies).toEqual([
      expect.objectContaining({ sourceArtifactId: sourceId, sourceRevision: 2 }),
    ]);
  });

  it('requires the user-triggered trim refresh after a bound render revision advances', async () => {
    const { service, working } = harness();
    const state = draft();
    const variant = state.templates[0]!.workspace.variants[0]!;
    variant.bindingRevisions[variant.slots[0]!.id] = 1;
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    await expect(service.validate('project', 'run', 7, templateId)).rejects.toMatchObject({
      status: 409,
    });
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });

  it('rejects a stale browser draft revision', async () => {
    const { service, working } = harness();
    await expect(service.validate('project', 'run', 6, templateId)).rejects.toMatchObject({
      status: 409,
    });
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
  });

  it('rejects repeated source clips inside one timeline', async () => {
    const { service, working } = harness();
    const state = draft();
    const variant = state.templates[0]!.workspace.variants[0]!;
    const secondId = 'a980df15-a13d-4ca4-977c-0a754ebc6382';
    variant.slots.push({ ...variant.slots[0]!, id: secondId });
    variant.bindings[secondId] = sourceId;
    variant.bindingRevisions[secondId] = 2;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    await expect(service.validate('project', 'run', 7, templateId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('assembles the dedicated workspace from the node draft and confirmed render clips', async () => {
    const { service } = harness();
    const result = await service.workspace('project', 'run');
    expect(result.draftRevision).toBe(7);
    expect(result.materials).toEqual([
      expect.objectContaining({ id: sourceId, artifactRevision: 2, available: true }),
    ]);
  });

  it('uses the stable output FileObject URL when an older render artifact also exposes one', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          files: [
            {
              id: 'file-1',
              fileObjectId: 'file-1',
              role: 'SEGMENT_CLIP',
              sortOrder: 0,
              originalFileName: 'clip.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 1,
              sha256: 'sha',
              previewKind: 'VIDEO',
              previewUrl: '/api/projects/project/file-objects/file-1/content',
              contentUrl: '/api/projects/project/file-objects/file-1/content',
              downloadUrl: '/api/projects/project/file-objects/file-1/content?download=true',
            },
          ],
        } as unknown as WorkingArtifact,
      ],
      total: 1,
    });

    const result = await service.workspace('project', 'run');

    expect(result.materials[0]?.contentUrl).toBe(
      '/api/projects/project/file-objects/file-1/content',
    );
  });

  it('exposes the source Prompt on each confirmed material', async () => {
    const prompt = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 3,
      contentHash: 'prompt-hash',
      payload: {
        items: [
          {
            id: 'prompt-1',
            code: 'P-001',
            content: '展示腊肠切片的油润质感',
            creativeCore: '暖色餐桌上的产品特写',
          },
        ],
      },
    } as unknown as WorkingArtifact;
    const render = {
      ...source,
      payload: {
        ...(source.payload as Record<string, unknown>),
        promptId: 'prompt-1',
      },
    } as WorkingArtifact;
    const working = {
      getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
      listArtifacts: vi.fn().mockResolvedValue({ items: [prompt, render], total: 2 }),
    };
    const service = new EffectTemplateMixService(working as unknown as WorkflowWorkingService);

    const result = await service.workspace('project', 'run');

    expect(result.materials[0]).toMatchObject({
      promptCode: 'P-001',
      promptText: '展示腊肠切片的油润质感',
      promptCreativeCore: '暖色餐桌上的产品特写',
    });
  });

  const batchArtifact = (taskIds: string[]) =>
    ({
      id: 'batch-artifact',
      nodeId: 'SEGMENT_RENDER',
      artifactKey: 'render-batch:product',
      kind: 'STRUCTURED',
      revision: 2,
      availability: 'AVAILABLE',
      freshness: 'CURRENT',
      payload: {
        schemaVersion: 1,
        productId: 'product',
        clips: taskIds.map((taskId) => ({ taskId })),
      },
    }) as unknown as WorkingArtifact;
  const workspaceWith = async (items: WorkingArtifact[]) => {
    const working = {
      getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
      listArtifacts: vi.fn().mockResolvedValue({ items, total: items.length }),
    };
    const service = new EffectTemplateMixService(working as unknown as WorkflowWorkingService);
    return service.workspace('project', 'run');
  };

  it('keeps a superseded batch’s clips out of the pool instead of counting them as expired', async () => {
    // A re-render replaces the batch and leaves the old clips behind; only the batch's own clips are
    // still offered by the render node, so the leftover must not read as an expired material.
    const superseded = {
      ...source,
      id: 'superseded-clip',
      artifactKey: 'render-clip:task-2',
      freshness: 'STALE',
    } as WorkingArtifact;

    const result = await workspaceWith([batchArtifact(['task-1']), source, superseded]);

    expect(result.materials.map(({ id }) => id)).toEqual([sourceId]);
  });

  it('still reports a stale clip the current batch lists so a Prompt edit stays visible', async () => {
    const result = await workspaceWith([
      batchArtifact(['task-1']),
      { ...source, freshness: 'STALE' } as WorkingArtifact,
    ]);

    expect(result.materials).toEqual([expect.objectContaining({ id: sourceId, available: false })]);
  });

  it('keeps a superseded clip an existing project is bound to and shows it as expired', async () => {
    // The draft binds this clip, so hiding it would blank the slot instead of telling the user the
    // project still points at a material whose Prompt moved on.
    const result = await workspaceWith([
      batchArtifact(['task-9']),
      { ...source, freshness: 'STALE' } as WorkingArtifact,
    ]);

    expect(result.materials).toEqual([expect.objectContaining({ id: sourceId, available: false })]);
  });

  it('keeps a current clip the batch no longer lists so a bound variant still resolves', async () => {
    // A same-Prompt re-render leaves the previous clips CURRENT, and smart fill reads through
    // `sourceArtifacts`, so it can still pick them: the pool has to keep them reachable.
    const result = await workspaceWith([batchArtifact(['task-9']), source]);

    expect(result.materials).toEqual([expect.objectContaining({ id: sourceId, available: true })]);
  });

  it('offers one card per rendered file when a branch inherits its ancestor’s clips', async () => {
    // Forking a branch clones the render stage, and `listArtifacts` surfaces the ancestor's copies of
    // it too, so the same clip reached the library twice — the same video appeared as two cards. The
    // branch's own artifact is the one its draft binds, so that is the card that has to survive, even
    // when the ancestor's copy is listed first.
    const inherited = {
      ...source,
      id: 'ancestor-clip',
      workflowRunId: 'parent-run',
    } as WorkingArtifact;
    const cloned = { ...source, workflowRunId: 'run' } as WorkingArtifact;

    const result = await workspaceWith([inherited, cloned]);

    expect(result.materials.map(({ id }) => id)).toEqual([sourceId]);
  });

  it('creates and fills exactly one project inside the requested template', async () => {
    const { service, working } = harness();
    const state = draft();
    state.templates[0]!.workspace.variants = [];
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    const result = await service.createVariant('project', 'run', templateId, 7);

    expect(result.draft.templates[0]!.workspace.variants).toHaveLength(1);
    expect(result.draft.templates[0]!.workspace.variants[0]!.bindings[slotId]).toBe(sourceId);
    expect(working.putNodeState).toHaveBeenCalledWith(
      'project',
      'run',
      'TEMPLATE_MIX',
      expect.objectContaining({ expectedRevision: 7 }),
    );
  });

  it('creates an empty project without deterministically filling any slot', async () => {
    const { service, working } = harness();
    const state = draft();
    state.templates[0]!.workspace.variants = [];
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    const result = await service.createEmptyVariant('project', 'run', templateId, 7);
    const created = result.draft.templates[0]!.workspace.variants[0]!;

    expect(created.bindings).toEqual({});
    expect(created.bindingRevisions).toEqual({});
    expect(created.offsets).toEqual({});
    expect(created.conflictSlotIds).toEqual([]);
  });

  it('allows adding empty projects beyond 100 after packaging has locked the template', async () => {
    const { working } = harness();
    const state = draft();
    const first = state.templates[0]!.workspace.variants[0]!;
    state.templates[0]!.workspace.variants = Array.from({ length: 100 }, (_, index) => ({
      ...(JSON.parse(JSON.stringify(first)) as EffectTemplateMixVariant),
      id: `variant-${index}`,
      name: `成片 ${index + 1}`,
    }));
    state.templates[0]!.packagingLocked = true;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      // A stale fill lease must not block the additive empty-project operation
      // after packaging has permanently locked the template.
      lockedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    const result = await service.createEmptyVariant('project', 'run', templateId, 7);

    expect(result.draft.templates[0]!.workspace.variants).toHaveLength(101);
    expect(result.draft.templates[0]!.packagingLocked).toBe(true);
    expect(result.draft.templates[0]!.workspace.variants.at(-1)!.bindings).toEqual({});

    working.getNodeState.mockResolvedValue({ revision: 8, state: result.draft });
    const nextResult = await service.createEmptyVariant('project', 'run', templateId, 8);
    expect(nextResult.draft.templates[0]!.workspace.variants).toHaveLength(102);
  });

  it('allows template configuration edits after packaging so the template can be filled again', async () => {
    const { working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 10 },
        },
      ],
      total: 1,
    });
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    const edited = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    edited.templates[0]!.workspace.variants[0]!.offsets[slotId] = 0.5;
    const afterProjectEdit = JSON.parse(JSON.stringify(edited)) as EffectTemplateMixDraft;
    const retimed = JSON.parse(JSON.stringify(afterProjectEdit)) as EffectTemplateMixDraft;
    retimed.templates[0]!.workspace.template.name = '包装后仍可修改的模板名';
    retimed.templates[0]!.workspace.template.slots[0]!.duration = 9;
    working.getNodeStateOrNull
      .mockResolvedValueOnce({ revision: 7, state: previous })
      .mockResolvedValueOnce({ revision: 8, state: afterProjectEdit })
      .mockResolvedValueOnce({ revision: 9, state: retimed });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const packageLockedService = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      packageLockedService.saveDraft('project', 'run', 7, edited),
    ).resolves.toBeDefined();
    expect(edited.templates[0]!.workspace.variants[0]!.offsets[slotId]).toBe(0.5);
    const result = await packageLockedService.saveDraft('project', 'run', 8, retimed);
    expect(result.draft.templates[0]!.workspace.template.name).toBe('包装后仍可修改的模板名');
    expect(result.draft.templates[0]!.workspace.template.slots[0]!.duration).toBe(9);
    // The flag is still reported: it keeps the packaged template out of deletion.
    expect(result.draft.templates[0]!.packagingLocked).toBe(true);
  });

  it('still refuses removing a project the finished package points at', async () => {
    const { working } = harness();
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    const removed = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    removed.templates[0]!.workspace.variants = [];
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(service.saveDraft('project', 'run', 7, removed)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('allows edits to a packaged template while packaging runs from its frozen snapshot', async () => {
    const { working } = harness();
    const state = draft();
    state.templates[0]!.packagingLocked = true;
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    const packaged = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      packaged as unknown as EffectTemplateMixAiRepository,
    );
    await expect(
      service.applyVariant('project', 'run', templateId, variantId, false, 7),
    ).resolves.toBeDefined();

    const running = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      {
        ...packaged,
        activePackagingTemplateIds: vi.fn().mockResolvedValue([templateId]),
      } as unknown as EffectTemplateMixAiRepository,
    );
    await expect(
      running.applyVariant('project', 'run', templateId, variantId, false, 7),
    ).resolves.toBeDefined();
  });

  it('allows switching the voice after packaging', async () => {
    const { working } = harness();
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    previous.templates[0]!.workspace.template.voiceProfileId = 'voice-a';
    const voiced = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    voiced.templates[0]!.workspace.template.voiceProfileId = 'voice-b';
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      activePackagingTemplateIds: vi.fn().mockResolvedValue([]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(service.saveDraft('project', 'run', 7, voiced)).resolves.toBeDefined();
    expect(voiced.templates[0]!.workspace.template.voiceProfileId).toBe('voice-b');
  });

  it('allows template configuration changes while packaging runs from its frozen snapshot', async () => {
    const { working } = harness();
    const previous = draft();
    previous.templates[0]!.packagingLocked = true;
    previous.templates[0]!.workspace.template.voiceProfileId = 'voice-a';
    const voiced = JSON.parse(JSON.stringify(previous)) as EffectTemplateMixDraft;
    voiced.templates[0]!.workspace.template.voiceProfileId = 'voice-b';
    working.getNodeStateOrNull.mockResolvedValue({ revision: 7, state: previous });
    const aiRuns = {
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      // The worker owns a frozen input snapshot and must not lock user edits in this Run.
      activePackagingTemplateIds: vi.fn().mockResolvedValue([templateId]),
      lockedTemplateIds: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([]),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await expect(service.saveDraft('project', 'run', 7, voiced)).resolves.toBeDefined();
    expect(voiced.templates[0]!.workspace.template.voiceProfileId).toBe('voice-b');
  });

  it('rejects a server mutation based on a stale draft revision', async () => {
    const { service, working } = harness();
    await expect(
      service.refillVariant('project', 'run', templateId, variantId, 6),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(working.putNodeState).not.toHaveBeenCalled();
  });

  it('applies an edited project only inside the requested template', async () => {
    const { service, working } = harness();
    working.listArtifacts.mockResolvedValue({
      items: [
        {
          ...source,
          payload: { ...(source.payload as Record<string, unknown>), durationSeconds: 8 },
        },
      ],
      total: 1,
    });
    const state = draft();
    const isolatedId = 'c61347b7-af3c-4667-a474-25a5c9bb00c1';
    state.templates.push({
      id: isolatedId,
      workspace: JSON.parse(JSON.stringify(state.templates[0]!.workspace)),
    });
    state.templates[0]!.workspace.variants[0]!.slots[0]!.duration = 5;
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    const result = await service.applyVariant('project', 'run', templateId, variantId, true, 7);

    expect(result.draft.templates[0]!.workspace.template.slots[0]!.duration).toBe(5);
    expect(result.draft.templates[1]!.workspace.template.slots[0]!.duration).toBe(4);
  });

  it('freezes original Prompt text without forwarding upstream purpose recommendations', async () => {
    const state = draft();
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    state.templates[0]!.workspace.template.slots = roles.map((role, index) => ({
      id: `slot-${index}`,
      label: role,
      role,
      purpose:
        role === 'HOOK'
          ? 'HOOK'
          : role === 'END'
            ? 'END_CONVERSION'
            : role === 'PRODUCT'
              ? 'PRODUCT_DISPLAY'
              : 'EFFECT',
      duration: 4,
      transition: '硬切',
    }));
    state.templates[0]!.workspace.variants = [];
    const now = new Date();
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 2,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({
          id: `prompt-${index}`,
          content: `原始画面 Prompt ${index}`,
        })),
      },
    };
    const clips = roles.map((_, index) => ({
      id: `material-${index}`,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: `render-clip:${index}`,
      revision: 3,
      contentHash: String(index).repeat(64),
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      storageKey: `video/${index}.mp4`,
      name: `素材 ${index} 视频片段`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 5,
        contentHash: 'v'.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 7, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'run' },
        parentWorkflowRunId: null,
        productIdMap: {},
        taskIdMap: {},
        created: false,
      }),
    };
    const create = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        kind: 'CREATED',
        run: {
          id: 'run-id',
          templateId,
          workflowRunId: input.workflowRunId,
          targetVariantId: null,
          outputVariantId: null,
          status: 'QUEUED',
          stage: 'CLASSIFYING',
          progress: 0,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        },
        input,
      }),
    );
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await service.createAiRun('project', 'run', templateId, 7, 'key');

    // Re-filling is a full update: it must ask for an isolated child before it reads the draft, and
    // `always` is what makes even the project's first fill land on a branch of its own.
    expect(working.beginEffectNodeEdit).toHaveBeenCalledWith(
      'project',
      'run',
      'TEMPLATE_MIX',
      'BATCH',
      {
        always: true,
        keepParentActive: false,
        creationKey: expect.any(String),
      },
    );
    expect(create.mock.calls[0]![0].workflowRunId).toBe('run');

    const snapshot = create.mock.calls[0]![0].snapshot;
    expect(snapshot.materials[0]).toMatchObject({ prompt: '原始画面 Prompt 0' });
    expect(snapshot.workspaceHash).toBe(workflowStateHash(state.templates[0]!.workspace));
    expect(JSON.stringify(snapshot)).not.toContain('primaryPurpose');
    expect(JSON.stringify(snapshot)).not.toContain('compatiblePurposes');

    const legacySnapshot = { ...snapshot };
    delete legacySnapshot.workspaceHash;
    const scores = Object.fromEntries(roles.map((role) => [role, 0.8]));
    const classifications = clips.map((clip) => ({ materialId: clip.id, scores, reasons: {} }));
    const selections = clips.map((clip, index) => ({
      variantIndex: 0,
      slotId: `slot-${index}`,
      materialId: clip.id,
      duration: 4,
      matchScore: 0.8,
      matchLevel: 'HIGH',
      classificationReason: '匹配',
    }));
    const trims = clips.map((clip, index) => ({
      variantIndex: 0,
      slotId: `slot-${index}`,
      materialId: clip.id,
      trimStartSeconds: 0,
      trimReason: '动作完整',
    }));
    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: legacySnapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims.slice(0, 1),
      },
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: legacySnapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims,
      },
    ]);
    const updatedState = JSON.parse(JSON.stringify(state)) as EffectTemplateMixDraft;
    updatedState.templates.push({
      id: 'other-template',
      workspace: JSON.parse(JSON.stringify(state.templates[0]!.workspace)),
    });
    working.getNodeState.mockResolvedValue({ revision: 8, state: updatedState });

    await service.createAiRun('project', 'run', templateId, 8, 'new-key');

    const resumed = create.mock.calls[1]![0];
    expect(resumed.initialClassifications).toHaveLength(6);
    expect(resumed.initialSelections).toHaveLength(6);
    expect(resumed.initialTrims).toHaveLength(6);

    const filledState = JSON.parse(JSON.stringify(state)) as EffectTemplateMixDraft;
    const filledEntry = filledState.templates[0]!;
    const originalSlots = JSON.parse(JSON.stringify(filledEntry.workspace.template.slots));
    filledEntry.workspace.template.editVersion += 1;
    filledEntry.workspace.template.slots = filledEntry.workspace.template.slots.map((slot) => ({
      ...slot,
      duration: 5,
    }));
    filledEntry.workspace.variants.push({
      id: variantId,
      name: '跑量模板 · 1',
      appliedTemplateVersion: 2,
      slots: originalSlots,
      bindings: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, clip.id])),
      bindingRevisions: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, 3])),
      offsets: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, 0])),
      bindingMetadata: {},
      manualSlotIds: [],
      conflictSlotIds: [],
      status: 'CURRENT',
      captions: [],
      subtitleStyle: 'standard',
      bgm: null,
      voice: null,
      originalVolume: 1,
    } as EffectTemplateMixVariant);
    working.getNodeState.mockResolvedValue({ revision: 9, state: filledState });
    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'COMPLETED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims,
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 9, 'refill-key', variantId);
    const refilling = create.mock.calls[2]![0];
    expect(refilling.initialSelections).toHaveLength(6);
    expect(refilling.initialSelections).toEqual(
      expect.arrayContaining(
        clips.map((clip, index) =>
          expect.objectContaining({ slotId: `slot-${index}`, materialId: clip.id, duration: 5 }),
        ),
      ),
    );
    expect(refilling.initialClassifications).toHaveLength(6);

    // A regeneration that does have a published version to protect lands in the forked child, and
    // the DTO tells the editor which Run it has to follow.
    working.beginEffectNodeEdit.mockResolvedValue({
      run: { id: 'child-run' },
      parentWorkflowRunId: 'run',
      productIdMap: {},
      taskIdMap: {},
      created: true,
    });
    const forked = await service.createAiRun(
      'project',
      'run',
      templateId,
      9,
      'fork-key',
      variantId,
    );
    expect(create.mock.calls[3]![0].workflowRunId).toBe('child-run');
    expect(forked.workflowRunId).toBe('child-run');

    // A transport failure before the first trim must still reuse confirmed classification
    // and server-selected bindings, rather than paying to classify the whole pool again.
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    working.beginEffectNodeEdit.mockResolvedValue({
      run: { id: 'run' },
      parentWorkflowRunId: null,
      productIdMap: {},
      taskIdMap: {},
      created: false,
    });
    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: [],
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 7, 'zero-trim-key');
    expect(create.mock.calls[4]![0].initialClassifications).toHaveLength(6);
    expect(create.mock.calls[4]![0].initialSelections).toHaveLength(6);
    expect(create.mock.calls[4]![0].initialTrims).toEqual([]);

    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: null,
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 7, 'null-trim-key');
    expect(create.mock.calls[5]![0].initialClassifications).toHaveLength(6);
    expect(create.mock.calls[5]![0].initialSelections).toHaveLength(6);
    expect(create.mock.calls[5]![0].initialTrims).toEqual([]);

    aiRepository.listRecent.mockResolvedValue([
      {
        status: 'FAILED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: [{ ...selections[0], materialId: 'foreign-material' }],
        trimResult: [],
      },
    ]);
    await service.createAiRun('project', 'run', templateId, 7, 'invalid-zero-trim-key');
    expect(create.mock.calls[6]![0].initialSelections).toBeUndefined();
  });

  it('starts a refill on a template that has already been packaged', async () => {
    // A fill lands on a branch of its own, so a finished package is a result to leave alone rather
    // than a reason to refuse the fill. Only packaging that is still running blocks it, and that is
    // enforced inside the repository's transaction.
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const state = draft();
    state.templates[0]!.workspace.template.slots = roles.map((role, index) => ({
      id: `slot-${index}`,
      label: role,
      role,
      purpose:
        role === 'HOOK'
          ? 'HOOK'
          : role === 'END'
            ? 'END_CONVERSION'
            : role === 'PRODUCT'
              ? 'PRODUCT_DISPLAY'
              : 'EFFECT',
      duration: 4,
      transition: '硬切',
    }));
    state.templates[0]!.workspace.variants = [];
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 2,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({ id: `prompt-${index}`, content: `Prompt ${index}` })),
      },
    };
    const clips = roles.map((_, index) => ({
      ...source,
      id: `material-${index}`,
      artifactKey: `render-clip:${index}`,
      storageKey: `video/${index}.mp4`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 4,
        contentHash: `${index}`.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 7, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'packaged-run' },
        parentWorkflowRunId: 'run',
        productIdMap: {},
        taskIdMap: {},
        created: true,
      }),
    };
    const create = vi.fn().mockResolvedValue({
      kind: 'CREATED',
      run: {
        id: 'fill-run',
        templateId,
        workflowRunId: 'packaged-run',
        targetVariantId: null,
        outputVariantId: null,
        status: 'QUEUED',
        stage: 'CLASSIFYING',
        progress: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      // The template already owns a CURRENT timeline-package in the Run the fill forked from.
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.createAiRun('project', 'run', templateId, 7, 'key'),
    ).resolves.toMatchObject({ workflowRunId: 'packaged-run' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fills from scratch when a fresh branch cannot reach the assignment it forked from', async () => {
    // A re-fill on an already assigned project used to be refused unless the classification behind
    // that assignment could be reused — but the fill always forks, and cloning re-identifies the
    // materials, so on a fresh branch the history never matches and every re-fill failed with
    // 找不到完整的历史归槽结果. It now classifies and assigns from scratch instead.
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const state = draft();
    state.templates[0]!.workspace.template.slots = roles.map((role, index) => ({
      id: `slot-${index}`,
      label: role,
      role,
      purpose:
        role === 'HOOK'
          ? 'HOOK'
          : role === 'END'
            ? 'END_CONVERSION'
            : role === 'PRODUCT'
              ? 'PRODUCT_DISPLAY'
              : 'EFFECT',
      duration: 4,
      transition: '硬切',
    }));
    state.templates[0]!.workspace.variants = [];
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 2,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({ id: `prompt-${index}`, content: `Prompt ${index}` })),
      },
    };
    const clips = roles.map((_, index) => ({
      ...source,
      id: `material-${index}`,
      artifactKey: `render-clip:${index}`,
      storageKey: `video/${index}.mp4`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 4,
        contentHash: `${index}`.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 7, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'child-run' },
        parentWorkflowRunId: 'run',
        productIdMap: {},
        taskIdMap: {},
        created: true,
      }),
    };
    const create = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        kind: 'CREATED',
        run: {
          id: 'fill-run',
          templateId,
          workflowRunId: input.workflowRunId,
          targetVariantId: null,
          outputVariantId: null,
          status: 'QUEUED',
          stage: 'CLASSIFYING',
          progress: 0,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    );
    const listRecent = vi.fn().mockResolvedValue([]);
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent,
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    // The first fill on the branch has nothing assigned yet, so it needs no history.
    await service.createAiRun('project', 'run', templateId, 7, 'first-key');
    const snapshot = create.mock.calls[0]![0].snapshot;

    // The branch the re-fill runs in knows the fill that produced this project, so the assignment can
    // still be reused when the history is genuinely reachable.
    const scores = Object.fromEntries(roles.map((role) => [role, 0.8]));
    listRecent.mockResolvedValue([
      {
        status: 'COMPLETED',
        templateId,
        inputSnapshot: snapshot,
        classificationResult: clips.map((clip) => ({ materialId: clip.id, scores, reasons: {} })),
      },
    ]);
    state.templates[0]!.workspace.variants.push({
      id: variantId,
      name: '跑量模板 · 1',
      appliedTemplateVersion: 2,
      slots: JSON.parse(JSON.stringify(state.templates[0]!.workspace.template.slots)),
      bindings: Object.fromEntries(clips.map((clip, index) => [`slot-${index}`, clip.id])),
      bindingRevisions: Object.fromEntries(clips.map((_clip, index) => [`slot-${index}`, 3])),
      offsets: Object.fromEntries(clips.map((_clip, index) => [`slot-${index}`, 0])),
      bindingMetadata: {},
      manualSlotIds: [],
      conflictSlotIds: [],
      status: 'CURRENT',
      captions: [],
      subtitleStyle: 'standard',
      bgm: null,
      voice: null,
      originalVolume: 1,
    } as EffectTemplateMixVariant);
    working.getNodeState.mockResolvedValue({ revision: 8, state });

    await service.createAiRun('project', 'run', templateId, 8, 'refill-key', variantId);

    const refill = create.mock.calls[1]![0];
    expect(refill.workflowRunId).toBe('child-run');
    expect(refill.initialClassifications).toHaveLength(6);
    expect(refill.initialSelections).toHaveLength(6);

    // A fresh branch has no history at all, because cloning re-identifies the materials, so the
    // classification that produced the current assignment is unreachable. The fill then starts from
    // scratch instead of refusing — the branch it lands on is new, so nothing the user already has is
    // overwritten.
    listRecent.mockResolvedValue([]);
    await service.createAiRun('project', 'run', templateId, 8, 'no-history-key', variantId);
    const fromScratch = create.mock.calls[2]![0];
    expect(fromScratch.workflowRunId).toBe('child-run');
    expect(fromScratch.initialSelections).toBeUndefined();
    expect(fromScratch.initialClassifications).toBeUndefined();
  });

  it('confirms the filled timeline as this Run’s mix version so the tree stops showing a draft', async () => {
    // A finished smart fill is a paid regeneration of the mix node, so the timeline it just wrote is
    // the node's version from that moment on — the same way a completed render batch confirms the
    // render node. Without this the branch tree shows 待校验 and packaging has no version to fork from.
    const { working } = harness();
    const snapshot = {
      schemaVersion: 1,
      template: {
        id: templateId,
        name: '跑量模板',
        editVersion: 2,
        slots: [{ id: slotId, role: 'HOOK', label: '片头钩子', duration: 4, transition: '硬切' }],
      },
      draftRevision: 7,
      targetVariantId: variantId,
      maxOutputVariants: 1,
      lockedBindings: [],
      existingVariantBindings: [],
      reuseCounts: {},
      promptArtifacts: [],
      materials: [
        {
          id: sourceId,
          duration: 4,
          artifactId: sourceId,
          artifactRevision: 2,
          fileObjectId: 'file-1',
        },
      ],
    };
    const scores = {
      HOOK: 0.9,
      PAIN_POINT: 0.8,
      PRODUCT: 0.8,
      SELLING_POINT: 0.8,
      TRANSFORMATION: 0.8,
      END: 0.8,
    };
    const classifications = [{ materialId: sourceId, scores, reasons: {} }];
    const selections = [
      {
        variantIndex: 0,
        slotId,
        materialId: sourceId,
        duration: 4,
        matchScore: 0.9,
        matchLevel: 'HIGH',
        classificationReason: '动作完整',
      },
    ];
    const trims = [
      {
        variantIndex: 0,
        slotId,
        materialId: sourceId,
        trimStartSeconds: 0,
        trimReason: '动作完整',
      },
    ];
    const now = new Date('2026-09-29T04:00:00.000Z');
    const aiRuns = {
      find: vi.fn().mockResolvedValue({
        id: 'ai-run',
        templateId,
        workflowRunId: 'run',
        targetVariantId: variantId,
        outputVariantId: null,
        status: 'RUNNING',
        stage: 'FILLING',
        progress: 80,
        attemptToken: 'token',
        inputSnapshot: snapshot,
        classificationResult: classifications,
        selectionResult: selections,
        trimResult: trims,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }),
      sourceArtifacts: vi.fn().mockResolvedValue([source]),
      completeWithDraft: vi.fn().mockResolvedValue('COMPLETED'),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRuns as unknown as EffectTemplateMixAiRepository,
    );

    await service.completeAiRun('project', 'ai-run', 'token', trims);

    expect(working.commitValidatedArtifacts).toHaveBeenCalledWith(
      'project',
      'run',
      'TEMPLATE_MIX',
      expect.arrayContaining([
        expect.objectContaining({ artifactKey: 'mix-template:' + templateId }),
        expect.objectContaining({
          artifactKey: 'timeline-project:' + templateId + ':' + variantId,
        }),
      ]),
    );
    expect(working.publishEffectNodeEdit).toHaveBeenCalledWith('project', 'run', 'TEMPLATE_MIX');
  });

  it('creates a trim-only refresh for changed clips without changing their slot assignments', async () => {
    const roles = [
      'HOOK',
      'PAIN_POINT',
      'PRODUCT',
      'SELLING_POINT',
      'TRANSFORMATION',
      'END',
    ] as const;
    const state = draft();
    const entry = state.templates[0]!;
    entry.workspace.template.slots = roles.map((role, index) => ({
      id: `refresh-slot-${index}`,
      label: `槽位 ${index + 1}`,
      role,
      purpose: 'HOOK',
      duration: 4,
      transition: '硬切',
    }));
    entry.workspace.variants = [
      {
        id: variantId,
        name: '跑量模板 · 1',
        appliedTemplateVersion: entry.workspace.template.editVersion,
        slots: JSON.parse(
          JSON.stringify(entry.workspace.template.slots),
        ) as typeof entry.workspace.template.slots,
        bindings: Object.fromEntries(
          roles.map((_, index) => [`refresh-slot-${index}`, `material-${index}`]),
        ),
        bindingRevisions: Object.fromEntries(roles.map((_, index) => [`refresh-slot-${index}`, 2])),
        offsets: Object.fromEntries(roles.map((_, index) => [`refresh-slot-${index}`, 0])),
        manualSlotIds: [],
        conflictSlotIds: [],
        status: 'CURRENT',
        captions: [],
        subtitleStyle: 'standard',
        bgm: null,
        voice: null,
        originalVolume: 1,
      } as EffectTemplateMixVariant,
    ];
    const promptArtifact = {
      id: 'prompt-artifact',
      nodeId: 'PROMPT_GENERATION',
      artifactKey: 'prompt-batch:product',
      revision: 3,
      contentHash: 'p'.repeat(64),
      payload: {
        items: roles.map((_, index) => ({ id: `prompt-${index}`, content: `Prompt ${index}` })),
      },
    };
    const clips = roles.map((_, index) => ({
      id: `material-${index}`,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: `render-clip:${index}`,
      revision: index === 2 ? 3 : 2,
      contentHash: `${index}`.repeat(64),
      freshness: 'CURRENT',
      availability: 'AVAILABLE',
      storageKey: `video/${index}.mp4`,
      name: `素材 ${index} 视频片段`,
      payload: {
        promptId: `prompt-${index}`,
        renderCode: `V${index}`,
        durationSeconds: 5,
        contentHash: 'v'.repeat(64),
        fileObjectId: `file-${index}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      },
    }));
    const working = {
      getNodeState: vi.fn().mockResolvedValue({ revision: 11, state }),
      beginEffectNodeEdit: vi.fn().mockResolvedValue({
        run: { id: 'run' },
        parentWorkflowRunId: null,
        productIdMap: {},
        taskIdMap: {},
        created: false,
      }),
    };
    const create = vi.fn().mockResolvedValue({
      kind: 'CREATED',
      run: {
        id: 'refresh-run',
        templateId,
        workflowRunId: 'run',
        targetVariantId: variantId,
        outputVariantId: null,
        status: 'QUEUED',
        stage: 'TRIMMING',
        progress: 0,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const aiRepository = {
      sourceArtifacts: vi.fn().mockResolvedValue([promptArtifact, ...clips]),
      listRecent: vi.fn().mockResolvedValue([]),
      // A completed package normally locks the template. The explicit
      // trim-only refresh is allowed; active packaging is still blocked by
      // the repository's transactional guard.
      packagedTemplateIds: vi.fn().mockResolvedValue([templateId]),
      create,
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await service.createAiRun('project', 'run', templateId, 11, 'refresh-key', variantId, true);

    const input = create.mock.calls[0]![0];
    expect(input.snapshot).toMatchObject({
      trimOnly: true,
      targetVariantId: variantId,
      refreshBindings: [
        { slotId: 'refresh-slot-2', materialId: 'material-2', artifactRevision: 3 },
      ],
    });
    expect(input.snapshot.lockedBindings).toHaveLength(5);
    expect(input.snapshot.trimOnly).toBe(true);
    expect(input.initialSelections).toHaveLength(1);
    expect(input.initialSelections[0]).toMatchObject({
      slotId: 'refresh-slot-2',
      materialId: 'material-2',
      duration: 4,
    });
    expect(input.initialClassifications).toBeUndefined();
  });

  it('persists a partial Prompt-classification shard for lease-safe resume', async () => {
    const materialId = 'material-1';
    const classifications = [
      {
        materialId,
        scores: {
          HOOK: 0.9,
          PAIN_POINT: 0.1,
          PRODUCT: 0.2,
          SELLING_POINT: 0.3,
          TRANSFORMATION: 0.4,
          END: 0.1,
        },
        reasons: {
          HOOK: 'Prompt 中存在开场动作',
          PAIN_POINT: '未明显体现痛点',
          PRODUCT: '产品可见',
          SELLING_POINT: '卖点较弱',
          TRANSFORMATION: '没有结果对比',
          END: '没有收尾动作',
        },
      },
    ];
    const aiRepository = {
      find: vi.fn().mockResolvedValue({
        status: 'RUNNING',
        attemptToken: 'attempt-token',
        inputSnapshot: {
          materials: [{ id: materialId }, { id: 'material-2' }],
        },
      }),
      saveClassificationCheckpoint: vi.fn().mockResolvedValue({
        kind: 'SAVED',
        classifications,
        progress: 20,
      }),
    };
    const service = new EffectTemplateMixService(
      {} as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.checkpointAiClassifications('project', 'run', 'attempt-token', classifications),
    ).resolves.toEqual({ classifications, progress: 20 });
    expect(aiRepository.saveClassificationCheckpoint).toHaveBeenCalledWith(
      'project',
      'run',
      'attempt-token',
      classifications,
    );
  });

  it('persists only selected-material sampling checkpoints', async () => {
    const materialId = 'material-1';
    const aiRepository = {
      find: vi.fn().mockResolvedValue({
        status: 'RUNNING',
        attemptToken: 'attempt-token',
        inputSnapshot: { materials: [{ id: materialId, duration: 10 }] },
        selectionResult: [{ materialId, duration: 4 }],
      }),
      saveSamplingCheckpoint: vi.fn().mockResolvedValue({
        kind: 'SAVED',
        materialIds: [materialId],
        samples: [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.checkpointAiSampling('project', 'run', 'attempt-token', {
        samples: [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
      }),
    ).resolves.toEqual({
      materialIds: [materialId],
      samples: [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
    });
    expect(aiRepository.saveSamplingCheckpoint).toHaveBeenCalledWith(
      'project',
      'run',
      'attempt-token',
      [{ materialId, frameTimestampsSeconds: [0.2, 5.5] }],
    );
    await expect(
      service.checkpointAiSampling('project', 'run', 'attempt-token', {
        materialIds: ['unselected'],
      }),
    ).rejects.toThrow('关键帧进度分片无效');
  });

  it('persists partial AI trim results for batch resume', async () => {
    const trims = [
      {
        variantIndex: 1,
        slotId,
        materialId: sourceId,
        trimStartSeconds: 0.5,
        trimReason: '动作完整',
      },
    ];
    const aiRepository = {
      find: vi.fn().mockResolvedValue({
        status: 'RUNNING',
        attemptToken: 'attempt-token',
        inputSnapshot: { materials: [{ id: sourceId, duration: 5 }] },
        selectionResult: [
          {
            variantIndex: 1,
            slotId,
            materialId: sourceId,
            duration: 4,
          },
        ],
      }),
      saveTrimCheckpoint: vi.fn().mockResolvedValue({
        kind: 'SAVED',
        trims,
        progress: 72,
      }),
    };
    const service = new EffectTemplateMixService(
      {} as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.checkpointAiTrims('project', 'run', 'attempt-token', trims),
    ).resolves.toEqual({ trims, progress: 72 });
  });

  const promptBatch = {
    id: 'prompt-artifact',
    nodeId: 'PROMPT_GENERATION',
    artifactKey: 'prompt-batch:product',
    revision: 3,
    contentHash: 'prompt-hash',
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
  } as unknown as WorkingArtifact;
  const scores = Object.fromEntries(
    ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'].map((role) => [
      role,
      0.9,
    ]),
  );
  const inheritedFill = (overrides: Record<string, unknown> = {}) => ({
    id: 'ancestor-fill',
    templateId,
    status: 'COMPLETED',
    createdAt: new Date('2026-09-29T04:00:00.000Z'),
    inputSnapshot: {
      template: { name: '跑量模板', slots: [{ id: slotId, role: 'HOOK', label: '片头钩子' }] },
      materials: [
        {
          id: 'ancestor-clip',
          artifactId: 'ancestor-clip',
          artifactKey: 'render-clip:task-1',
          artifactRevision: 99,
          contentHash: 'ancestor-hash',
          fileObjectId: 'file-1',
          promptId: 'ancestor-prompt',
        },
      ],
      promptArtifacts: [
        {
          id: 'ancestor-prompt-artifact',
          artifactKey: 'prompt-batch:ancestor',
          revision: 9,
          contentHash: 'ancestor-prompt-hash',
        },
      ],
    },
    classificationResult: [{ materialId: 'ancestor-clip', scores, reasons: {} }],
    ...overrides,
  });
  const workspaceWithInherited = async (inherited: unknown[]) => {
    // The committed row carries the hash the pool guard compares, not the one in the clip payload.
    const clip = { ...source, contentHash: 'sha' } as unknown as WorkingArtifact;
    const working = {
      getNodeStateOrNull: vi.fn().mockResolvedValue({ revision: 7, state: draft() }),
      listArtifacts: vi.fn().mockResolvedValue({ items: [promptBatch, clip], total: 2 }),
    };
    const aiRepository = {
      listRecent: vi.fn().mockResolvedValue([]),
      sourceArtifacts: vi.fn().mockResolvedValue([promptBatch, clip]),
      inheritedMixAiRuns: vi.fn().mockResolvedValue(inherited),
    };
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );
    return service.workspace('project', 'run');
  };

  it('reads the pool out of a fill the branch inherited from an ancestor', async () => {
    // The snapshot names the ancestor's artifacts, revisions and hashes; the branch only kept the
    // rendered files. Matching the two up by file is what keeps the material library from falling
    // back to how it looked before the fill.
    const result = await workspaceWithInherited([inheritedFill()]);

    expect(result.classificationPools).toEqual([
      {
        templateId,
        runId: 'ancestor-fill',
        templateEditVersion: draft().templates[0]!.workspace.template.editVersion,
        items: [{ materialId: sourceId, role: 'HOOK', matchScore: 0.9 }],
      },
    ]);
    // The fill is not this Run's own, so the fill history still shows what this Run ran.
    expect(result.aiRuns).toEqual([]);
  });

  it('drops an inherited fill whose clips are not the ones this Run holds', async () => {
    const fill = inheritedFill({
      inputSnapshot: {
        ...(inheritedFill().inputSnapshot as Record<string, unknown>),
        materials: [
          {
            id: 'ancestor-clip',
            artifactRevision: 99,
            contentHash: 'ancestor-hash',
            fileObjectId: 'file-elsewhere',
          },
        ],
      },
    });

    const result = await workspaceWithInherited([fill]);

    expect(result.classificationPools).toEqual([]);
  });

  it('drops an inherited fill that froze a different template layout', async () => {
    const fill = inheritedFill({
      inputSnapshot: {
        ...(inheritedFill().inputSnapshot as Record<string, unknown>),
        template: { name: '跑量模板', slots: [{ id: slotId, role: 'PRODUCT', label: '产品展示' }] },
      },
    });

    const result = await workspaceWithInherited([fill]);

    expect(result.classificationPools).toEqual([]);
  });
});
