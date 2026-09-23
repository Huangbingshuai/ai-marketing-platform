import type { EffectTemplateMixDraft, WorkingArtifact } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';

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
  };
  return {
    working,
    service: new EffectTemplateMixService(working as unknown as WorkflowWorkingService),
  };
};

describe('EffectTemplateMixService', () => {
  it('projects persisted stage shard counts and a few real inputs and outputs', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const inputSnapshot = {
      materials: Array.from({ length: 5 }, (_, index) => ({
        id: `material-${index + 1}`,
        code: `R-${index + 1}`,
        name: `素材 ${index + 1}`,
      })),
      template: { slots: [{ id: slotId, label: '片头钩子' }] },
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
          { materialId: 'material-1' },
          { materialId: 'material-2' },
          { materialId: 'material-3' },
        ],
        selectionResult: [
          { materialId: 'material-1', slotId },
          { materialId: 'material-2', slotId },
        ],
        samplingResult: ['material-1'],
        trimResult: [{ materialId: 'material-1', trimStartSeconds: 1.25 }],
      }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );

    const run = await service.aiRun('project', 'run-id');

    expect(run.stageDetails.CLASSIFYING).toMatchObject({ completed: 3, total: 5 });
    expect(run.stageDetails.CLASSIFYING?.inputSamples).toEqual([
      'R-1 · 素材 1',
      'R-2 · 素材 2',
      'R-3 · 素材 3',
      'R-4 · 素材 4',
    ]);
    expect(run.stageDetails.MATCHING).toMatchObject({ completed: 1, total: 1 });
    expect(run.stageDetails.SAMPLING).toMatchObject({ completed: 1, total: 2 });
    expect(run.stageDetails.TRIMMING?.outputSamples).toEqual([
      'R-1 · 素材 1 · 从 1.3 秒截取',
    ]);
    expect(run.stageDetails.COMPLETED).toMatchObject({ completed: 0, total: 1 });
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
    await expect(service.saveDraft('project', 'run', 7, unchanged)).rejects.toMatchObject({ status: 400 });
  });

  it('allows the first 4-second draft without a previous node state', async () => {
    const { service, working } = harness();
    working.getNodeStateOrNull.mockResolvedValue(null);
    await expect(service.saveDraft('project', 'run', null, draft())).resolves.toBeDefined();
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
    const service = new EffectTemplateMixService(
      working as unknown as WorkflowWorkingService,
    );

    const result = await service.workspace('project', 'run');

    expect(result.materials[0]).toMatchObject({
      promptCode: 'P-001',
      promptText: '展示腊肠切片的油润质感',
      promptCreativeCore: '暖色餐桌上的产品特写',
    });
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
    };
    const create = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        kind: 'CREATED',
        run: {
          id: 'run-id',
          templateId,
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

    const snapshot = create.mock.calls[0]![0].snapshot;
    expect(snapshot.materials[0]).toMatchObject({ prompt: '原始画面 Prompt 0' });
    expect(JSON.stringify(snapshot)).not.toContain('primaryPurpose');
    expect(JSON.stringify(snapshot)).not.toContain('compatiblePurposes');
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
        selectionResult: [{ materialId }],
      }),
      saveSamplingCheckpoint: vi.fn().mockResolvedValue({ kind: 'SAVED', materialIds: [materialId] }),
    };
    const service = new EffectTemplateMixService(
      {} as unknown as WorkflowWorkingService,
      aiRepository as unknown as EffectTemplateMixAiRepository,
    );

    await expect(
      service.checkpointAiSampling('project', 'run', 'attempt-token', [materialId]),
    ).resolves.toEqual({ materialIds: [materialId] });
    expect(aiRepository.saveSamplingCheckpoint).toHaveBeenCalledWith(
      'project',
      'run',
      'attempt-token',
      [materialId],
    );
    await expect(
      service.checkpointAiSampling('project', 'run', 'attempt-token', ['unselected']),
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
});
