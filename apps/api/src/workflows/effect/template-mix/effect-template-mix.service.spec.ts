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
              duration: 3,
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
                duration: 3,
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
  it('saves algorithmic combinations as a draft without committing downstream artifacts', async () => {
    const { service, working } = harness();
    const state = draft();
    const entry = state.templates[0]!.workspace;
    const secondSlot = {
      ...entry.template.slots[0]!,
      id: '9b93d456-6c23-4d70-b97c-a41b624f002e',
      role: 'TRANSFORMATION' as const,
    };
    entry.template.slots.push(secondSlot);
    const clips = [
      sourceId,
      'c3be972a-752d-4abe-9966-9c7858560083',
      '79aa15c5-e7f6-485d-941e-0346d8084c1d',
      '8b534cd4-ddd7-4c4b-b64c-ac8ebae44561',
    ];
    const first = entry.variants[0]!;
    first.slots.push(secondSlot);
    first.bindings[secondSlot.id] = clips[2]!;
    first.bindingRevisions[secondSlot.id] = 2;
    first.offsets[secondSlot.id] = 0;
    const metadata = {
      source: 'AI' as const,
      matchScore: 0.8,
      matchLevel: 'NORMAL' as const,
      classificationReason: 'Prompt',
      trimReason: '关键帧',
    };
    first.bindingMetadata = { [slotId]: metadata, [secondSlot.id]: metadata };
    const sibling = structuredClone(first);
    sibling.id = '487fda04-a97a-4243-bace-0b16de67e0ee';
    sibling.bindings[slotId] = clips[1]!;
    sibling.bindings[secondSlot.id] = clips[3]!;
    entry.variants.push(sibling);
    working.getNodeState.mockResolvedValue({ revision: 7, state });
    working.listArtifacts.mockResolvedValue({
      items: clips.map((id) => ({ ...source, id, contentUrl: `/content/${id}` })),
      total: 4,
    });

    const result = await service.composeVariants('project', 'run', templateId, 7);
    const variants = result.draft.templates[0]!.workspace.variants;
    expect(variants).toHaveLength(4);
    expect(
      new Set(
        variants.map((variant) => `${variant.bindings[slotId]}|${variant.bindings[secondSlot.id]}`),
      ).size,
    ).toBe(4);
    expect(working.putNodeState).toHaveBeenCalled();
    expect(working.commitValidatedArtifacts).not.toHaveBeenCalled();
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
    state.templates[0]!.workspace.variants[0]!.slots[0]!.duration = 2;
    working.getNodeState.mockResolvedValue({ revision: 7, state });

    const result = await service.applyVariant('project', 'run', templateId, variantId, true, 7);

    expect(result.draft.templates[0]!.workspace.template.slots[0]!.duration).toBe(2);
    expect(result.draft.templates[1]!.workspace.template.slots[0]!.duration).toBe(3);
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
      duration: 3,
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
        inputSnapshot: { materials: [{ id: sourceId, duration: 4 }] },
        selectionResult: [
          {
            variantIndex: 1,
            slotId,
            materialId: sourceId,
            duration: 3,
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
