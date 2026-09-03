import { createHash } from 'node:crypto';

import type { EffectPromptItem } from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_LIMITS,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import { EffectPromptService } from './effect-prompt.service';
import { compileEffectPromptSharedPrompt, recomputePromptQuality } from './effect-prompt.quality';

const completionGateFixture = (duplicate = false) => {
  const settings = { targetCount: 10, defaultDurationSeconds: 5 };
  const fragmentTypes = [
    'HOOK',
    'HOOK',
    'HOOK',
    'HOOK',
    'HOOK',
    'PAIN',
    'PRODUCT_DISPLAY',
    'SELLING_POINT_EXPLANATION',
    'CTA',
    'OUTRO',
  ] as const;
  const contents = [
    '晨光厨房里，成年人拿起杯盖靠近窗边，近景缓慢推进，停在尚未揭晓的局部。',
    duplicate
      ? '晨光厨房里，成年人拿起杯盖靠近窗边，近景缓慢推进，停在尚未揭晓的局部。'
      : '晨光厨房里，成年人拿起杯盖靠近窗边，近景缓慢推进，停在尚未揭晓的局部细节。',
    '通勤车厢内，成年人握住松动提带尝试调整，侧面近景跟随手腕，提带仍轻轻晃动。',
    '夜间书桌前，一只手揭开收纳盒一角，微距焦点落在内部阴影，动作停在半开状态。',
    '午后阳台上，成年人轻推花架边缘，低位近景保持盆栽轮廓，花架在窗前停住。',
    '狭窄玄关里，成年人尝试把杂乱物品放入抽屉，抽屉受阻停住，问题仍然存在。',
    '门店展示台上，产品首帧居中，一只手扶正盒身，平视近景保持轮廓清楚后停稳。',
    '午后餐桌上，成年人转动产品露出表面纹理，微距焦点保持在真实材质并停止动作。',
    '明亮台面上，一只手把产品轻放在画面左侧，固定近景保持右侧连续留白并停稳。',
    '安静背景前，产品稳定居中，蒸汽逐渐变缓，固定近景保持上方留白与静物构图。',
  ];
  const now = '2026-08-27T00:00:00.000Z';
  const items = fragmentTypes.map((fragmentType, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    code: `P${String(index + 1).padStart(3, '0')}`,
    origin: 'AI' as const,
    fragmentType,
    primaryPurpose: fragmentType,
    compatiblePurposes: [fragmentType],
    classificationStatus: 'VERIFIED' as const,
    productRelevance: 85,
    materialTags: [fragmentType, String(index)],
    targetDurationSeconds: 5,
    creativeCore: `创意主线-${index}`,
    dimensions: {
      narrative: `叙事-${index}`,
      scene: index === 1 ? '场景-0' : `场景-${index}`,
      persona: index === 1 ? '人物-0' : `人物-${index}`,
      productRelation: `产品关联-${index}`,
      camera: index === 1 ? '镜头-0' : `镜头-${index}`,
      emotion: index === 1 ? '情绪-0' : `情绪-${index}`,
    },
    content: contents[index]!,
    insightBindings: [],
    manualEdited: false,
    createdAt: now,
    updatedAt: now,
  }));
  return recomputePromptQuality(items, settings, undefined, undefined, undefined, {
    status: 'VERIFIED',
    evaluatedCount: items.length,
    duplicateGroupCount: 0,
    duplicateCount: 0,
    duplicateRate: 0,
  });
};

const currentInputSnapshot = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'project-a',
  workflowRunId: 'workflow-a',
  productId: 'product-a',
  operation: 'BATCH_GENERATE',
  targetItemId: null,
  settings: { targetCount: 50, defaultDurationSeconds: 5 },
  insightArtifact: {
    id: 'insight-a',
    revision: 1,
    contentHash: 'insight-hash-current',
    result: { productName: '广式腊肠' },
  },
  retainedManualItems: [],
  selectionPolicy: 'MMR_CONTENT',
  baseResultRevision: null,
  ...overrides,
});

describe('EffectPromptService settings contract', () => {
  it('rejects mock completion unless the deployment explicitly opts in', async () => {
    const previous = process.env.EFFECT_PROMPT_ALLOW_MOCK_COMPLETION;
    delete process.env.EFFECT_PROMPT_ALLOW_MOCK_COMPLETION;
    const repository = { complete: vi.fn() };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);
    try {
      await expect(
        service.complete('project-a', 'run-a', 'attempt-a', {
          result: completionGateFixture(),
          executionMode: 'MOCK',
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(repository.complete).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.EFFECT_PROMPT_ALLOW_MOCK_COMPLETION;
      else process.env.EFFECT_PROMPT_ALLOW_MOCK_COMPLETION = previous;
    }
  });

  it('reuses only the current run fact visual strategy checkpoint with the same insight content hash', async () => {
    const templateHash = 'a'.repeat(64);
    const matching = {
      nodeId: 'FACT_VISUAL_STRATEGY_COMPILATION',
      sourceFingerprint: 'insight-hash-current',
      allocationHash: 'c'.repeat(64),
      templateHash,
      plan: {
        sourceContentHash: 'insight-hash-current',
        templateHash,
        strategyHash: 'b'.repeat(64),
        policies: [{ factId: 'fact-1' }],
      },
    };
    const stale = {
      ...matching,
      sourceFingerprint: 'insight-hash-old',
      allocationHash: 'd'.repeat(64),
    };
    const repository = {
      claim: vi.fn().mockResolvedValue({
        kind: 'CLAIMED',
        run: { sourceFingerprint: 'run-source' },
        attemptToken: 'attempt-a',
        input: currentInputSnapshot(),
        checkpointStages: [
          { nodeId: 'FACT_VISUAL_STRATEGY_COMPILATION', metadata: { checkpoint: stale } },
          { nodeId: 'FACT_VISUAL_STRATEGY_COMPILATION', metadata: { checkpoint: matching } },
        ],
      }),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    const output = await service.claim('project-a', 'run-a');

    expect(output.stageCheckpoints).toEqual([matching]);
  });

  it('ignores legacy visual strategy checkpoints that the current worker cannot validate', async () => {
    const legacy = {
      nodeId: 'FACT_VISUAL_STRATEGY_COMPILATION',
      sourceFingerprint: 'insight-hash-current',
      allocationHash: 'c'.repeat(64),
      templateHash: 'legacy-template',
      plan: {
        sourceContentHash: 'insight-hash-current',
        templateHash: 'legacy-template',
        strategyHash: 'b'.repeat(64),
        policies: [{ factId: 'fact-1' }],
      },
    };
    const repository = {
      claim: vi.fn().mockResolvedValue({
        kind: 'CLAIMED',
        run: { sourceFingerprint: 'run-source' },
        attemptToken: 'attempt-a',
        input: currentInputSnapshot(),
        checkpointStages: [
          { nodeId: 'FACT_VISUAL_STRATEGY_COMPILATION', metadata: { checkpoint: legacy } },
        ],
      }),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    const output = await service.claim('project-a', 'run-a');

    expect(output.stageCheckpoints).toEqual([]);
  });

  it('forwards the current run creative direction checkpoint for shard recovery', async () => {
    const checkpoint = {
      nodeId: 'COHERENT_CREATIVE_GENERATION',
      sourceFingerprint: 'a'.repeat(64),
      allocationHash: 'b'.repeat(64),
      templateHash: 'c'.repeat(64),
      plan: {
        directions: [],
        sourceHash: 'a'.repeat(64),
        planHash: 'b'.repeat(64),
        templateHash: 'c'.repeat(64),
        reusedCheckpoint: false,
      },
    };
    const repository = {
      claim: vi.fn().mockResolvedValue({
        kind: 'CLAIMED',
        run: { sourceFingerprint: 'run-source' },
        attemptToken: 'attempt-a',
        input: currentInputSnapshot(),
        checkpointStages: [{ nodeId: 'COHERENT_CREATIVE_GENERATION', metadata: { checkpoint } }],
      }),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    const output = await service.claim('project-a', 'run-a');

    expect(output.stageCheckpoints).toEqual([checkpoint]);
  });

  it('normalizes and forwards visual item-regeneration direction without opening a batch path', async () => {
    const dimensions = {
      narrative: ' 场景代入型 ',
      scene: ' 家庭餐桌 ',
      persona: ' 仅手部出镜 ',
      productRelation: ' 单手开合 ',
      camera: ' 桌面近景缓慢推进 ',
      emotion: ' 温暖舒缓 ',
    };
    const run = {
      id: 'run-a',
      projectId: 'project-a',
      workflowRunId: 'workflow-a',
      productId: 'product-a',
      operation: 'ITEM_REGENERATE',
      targetItemId: '11111111-1111-4111-8111-111111111111',
      status: 'QUEUED',
      progress: 0,
      currentNode: null,
      warnings: [],
      errorMessage: null,
      stages: [],
      result: null,
      createdAt: new Date('2026-08-26T00:00:00.000Z'),
      updatedAt: new Date('2026-08-26T00:00:00.000Z'),
    };
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      startRun: vi.fn().mockResolvedValue({ kind: 'CREATED', run }),
      run: vi.fn().mockResolvedValue(run),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    await service.start('project-a', 'product-a', {
      workflowRunId: 'workflow-a',
      operation: 'ITEM_REGENERATE',
      targetItemId: run.targetItemId,
      regenerationInstruction: '  产品更早出现  ',
      replacementDimensions: dimensions,
      regenerationMode: 'PRESERVE_PRODUCT_RELATION',
      regenerationReasons: ['ACTION_UNREASONABLE', 'TOO_SIMILAR'],
      preservedDimensions: ['productRelation', 'persona'],
      expectedSettingsRevision: 2,
      expectedResultRevision: 3,
      idempotencyKey: 'regen-a',
    });

    expect(repository.startRun).toHaveBeenCalledWith(
      'project-a',
      'workflow-a',
      'product-a',
      expect.objectContaining({
        operation: 'ITEM_REGENERATE',
        regenerationInstruction: '产品更早出现',
        regenerationMode: 'PRESERVE_PRODUCT_RELATION',
        regenerationReasons: ['ACTION_UNREASONABLE', 'TOO_SIMILAR'],
        preservedDimensions: ['productRelation', 'persona'],
        replacementDimensions: {
          narrative: '场景代入型',
          scene: '家庭餐桌',
          persona: '仅手部出镜',
          productRelation: '单手开合',
          camera: '桌面近景缓慢推进',
          emotion: '温暖舒缓',
        },
      }),
    );
  });

  it('starts ITEM_EVALUATE without accepting regeneration instructions', async () => {
    const targetItemId = '11111111-1111-4111-8111-111111111111';
    const run = {
      id: 'run-evaluate',
      projectId: 'project-a',
      workflowRunId: 'workflow-a',
      productId: 'product-a',
      operation: 'ITEM_REGENERATE',
      targetItemId,
      inputSnapshot: {
        ...currentInputSnapshot({ operation: 'ITEM_EVALUATE', targetItemId }),
      },
      status: 'QUEUED',
      progress: 0,
      currentNode: null,
      warnings: [],
      errorMessage: null,
      errorCode: null,
      attemptCount: 0,
      stages: [],
      result: null,
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
      updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    };
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      startRun: vi.fn().mockResolvedValue({ kind: 'CREATED', run }),
      run: vi.fn().mockResolvedValue(run),
    };
    const service = new EffectPromptService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const output = await service.start('project-a', 'product-a', {
      workflowRunId: 'workflow-a',
      operation: 'ITEM_EVALUATE',
      targetItemId,
      expectedSettingsRevision: 2,
      expectedResultRevision: 3,
      idempotencyKey: 'evaluate-a',
    });

    expect(repository.startRun).toHaveBeenCalledWith(
      'project-a',
      'workflow-a',
      'product-a',
      expect.objectContaining({
        operation: 'ITEM_EVALUATE',
        targetItemId,
        regenerationInstruction: null,
        replacementDimensions: null,
      }),
    );
    expect(output.run.operation).toBe('ITEM_EVALUATE');
    expect(output.run.nodes.map(({ nodeId }) => nodeId)).toContain('ITEM_EVALUATE');
  });

  it('accepts the fourth diversity-supplement shard round', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        id: 'run-current',
        inputSnapshot: currentInputSnapshot(),
        operation: 'BATCH_GENERATE',
      }),
      saveShard: vi.fn().mockResolvedValue(true),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);
    const input = {
      status: 'SUCCEEDED' as const,
      combinationPlan: [],
      items: [],
      creativePlan: [],
      creativeItems: [],
      warnings: [],
    };

    await expect(
      service.saveShard('project-a', 'run-current', 'attempt-a', 4, 0, 'CREATIVE', input),
    ).resolves.toEqual({ accepted: true });
    await expect(
      service.saveShard('project-a', 'run-current', 'attempt-a', 5, 0, 'CREATIVE', input),
    ).rejects.toThrow('分片标识无效');
  });

  it('projects persisted shards only into their phase-specific fields', async () => {
    const creativePlan = [{ slotId: 'creative-task-a' }];
    const creativeItems = [{ slotId: 'creative-a', content: '创意候选正文' }];
    const classificationPlan = ['creative-a'];
    const evaluations = [{ slotId: 'creative-a', primaryPurpose: 'HOOK' }];
    const repository = {
      run: vi.fn().mockResolvedValue({
        id: 'run-current',
        inputSnapshot: currentInputSnapshot(),
        operation: 'BATCH_GENERATE',
      }),
      shards: vi.fn().mockResolvedValue([
        {
          phase: 'BLUEPRINT',
          round: 0,
          shardIndex: 0,
          status: 'SUCCEEDED',
          combinationPlan: creativePlan,
          items: creativeItems,
          warnings: [],
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date('2026-08-28T00:00:00.000Z'),
        },
        {
          phase: 'PROMPT',
          round: 0,
          shardIndex: 0,
          status: 'SUCCEEDED',
          combinationPlan: classificationPlan,
          items: evaluations,
          warnings: [],
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date('2026-08-28T00:00:00.000Z'),
        },
      ]),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    const output = await service.shards('project-a', 'run-current', 'attempt-a');

    expect(output.shards).toEqual([
      expect.objectContaining({
        phase: 'CREATIVE',
        creativePlan,
        creativeItems,
        classificationPlan: [],
        evaluations: [],
      }),
      expect.objectContaining({
        phase: 'CLASSIFICATION',
        creativePlan: [],
        creativeItems: [],
        classificationPlan,
        evaluations,
      }),
    ]);
    expect(
      output.shards.every((shard) => !('combinationPlan' in shard) && !('items' in shard)),
    ).toBe(true);
  });

  it('rejects item-only regeneration fields on a batch run', async () => {
    const repository = { workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }) };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    await expect(
      service.start('project-a', 'product-a', {
        workflowRunId: 'workflow-a',
        operation: 'BATCH_GENERATE',
        regenerationInstruction: '不应允许',
        expectedSettingsRevision: 2,
        idempotencyKey: 'batch-a',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('persists an exhausted incomplete batch as a needs-review draft', async () => {
    const now = '2026-08-26T00:00:00.000Z';
    const shortResult = recomputePromptQuality(
      [
        {
          id: '11111111-1111-4111-8111-111111111111',
          code: 'P001',
          origin: 'AI',
          fragmentType: 'HOOK',
          primaryPurpose: 'HOOK',
          compatiblePurposes: ['HOOK'],
          classificationStatus: 'VERIFIED',
          productRelevance: 80,
          materialTags: ['钩子'],
          targetDurationSeconds: 5,
          creativeCore: '家庭厨房中的产品切面悬念',
          dimensions: {
            narrative: '痛点前置',
            scene: '家庭厨房',
            persona: '穿围裙的成年人',
            productRelation: '真实切面',
            camera: '中近景缓慢推进',
            emotion: '惊喜发现',
          },
          content: '家庭厨房里，穿围裙的成年人拿起产品转向镜头，镜头缓慢推进并停在真实切面。',
          insightBindings: [],
          manualEdited: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      DEFAULT_EFFECT_PROMPT_SETTINGS,
    );
    const repository = {
      run: vi.fn().mockResolvedValue({
        inputSnapshot: {
          selectionPolicy: 'MMR_CONTENT',
          operation: 'BATCH_GENERATE',
          settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
        },
      }),
      complete: vi.fn().mockResolvedValue({ kind: 'COMPLETED', result: { id: 'result-a' } }),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    await expect(
      service.complete('project-a', 'run-a', 'attempt-a', {
        result: shortResult,
        executionMode: 'ARK',
      }),
    ).resolves.toEqual({ promptResultId: 'result-a' });
    expect(repository.complete).toHaveBeenCalledWith(
      'project-a',
      'run-a',
      'attempt-a',
      expect.objectContaining({ qualityStatus: 'NEEDS_REVIEW' }),
    );
  });

  it('uses the extracted product name for the committed Prompt working artifact', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        id: 'run-a',
        inputSnapshot: {
          productId: 'product-a',
          insightArtifact: {
            id: 'insight-a',
            revision: 1,
            contentHash: 'a'.repeat(64),
            result: { productName: '广式腊肠' },
          },
        },
      }),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    const input = await (
      service as unknown as {
        artifactInput: (record: unknown, draft: unknown) => Promise<{ name: string } | null>;
      }
    ).artifactInput(
      {
        projectId: 'project-a',
        productId: 'product-a',
        runId: 'run-a',
        id: 'result-a',
      },
      { qualityStatus: 'PASS' },
    );

    expect(input?.name).toBe('广式腊肠 差异化 Prompt 批次');
  });

  it('returns the shared settingsRevision field after CAS save', async () => {
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      products: vi.fn().mockResolvedValue([{ id: 'product-a' }]),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const savedAt = new Date('2026-08-25T00:00:00.000Z');
    const workingRepository = {
      saveNodeState: vi.fn().mockResolvedValue({
        conflict: false,
        unchanged: false,
        record: { revision: 7, savedAt },
      }),
    };
    const service = new EffectPromptService(
      repository as never,
      projects as never,
      workingRepository as never,
    );

    await expect(
      service.saveSettings('project-a', 'product-a', 'workflow-a', 6, {
        ...DEFAULT_EFFECT_PROMPT_SETTINGS,
      }),
    ).resolves.toEqual({
      productId: 'product-a',
      settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
      settingsRevision: 7,
      unchanged: false,
      savedAt: savedAt.toISOString(),
    });
  });

  it('rejects a Prompt target count above the hard limit of 100', async () => {
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      products: vi.fn().mockResolvedValue([{ id: 'product-a' }]),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const workingRepository = { saveNodeState: vi.fn() };
    const service = new EffectPromptService(
      repository as never,
      projects as never,
      workingRepository as never,
    );

    await expect(
      service.saveSettings('project-a', 'product-a', 'workflow-a', null, {
        targetCount: 101,
        defaultDurationSeconds: 5,
      }),
    ).rejects.toThrow('Prompt 批次设置不符合允许范围');
    expect(workingRepository.saveNodeState).not.toHaveBeenCalled();
  });

  it('saves the single shared-prompt editor content and keeps the batch in draft', async () => {
    const draft = recomputePromptQuality([], DEFAULT_EFFECT_PROMPT_SETTINGS);
    const savedAt = new Date('2026-08-26T08:00:00.000Z');
    const repository = {
      result: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        revision: 3,
        draftResult: draft,
      }),
      mutateResult: vi
        .fn()
        .mockImplementation(
          (
            _projectId: string,
            _resultId: string,
            _revision: number,
            mutation: { sharedPrompt: unknown },
          ) => ({
            kind: 'UPDATED',
            result: {
              id: 'result-a',
              productId: 'product-a',
              revision: 4,
              savedAt,
              updatedAt: savedAt,
            },
            draft: { ...draft, sharedPrompt: mutation.sharedPrompt },
          }),
        ),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.updateSharedPrompt(
      'project-a',
      'result-a',
      3,
      '  保持产品外观前后一致。  ',
    );

    const expected = compileEffectPromptSharedPrompt([], '保持产品外观前后一致。');
    expect(repository.mutateResult).toHaveBeenCalledWith('project-a', 'result-a', 3, {
      kind: 'SHARED_PROMPT',
      sharedPrompt: expected,
    });
    expect(output.result.sharedPrompt).toEqual(expected);
    expect(output.revision).toBe(4);
  });

  it('preserves the system-owned prefix when saving the single shared-prompt editor', async () => {
    const renderProfile = {
      ...recomputePromptQuality([], DEFAULT_EFFECT_PROMPT_SETTINGS).renderProfile,
      sharedConstraints: {
        disabledElements: ['品牌水印'],
        contentHash: createHash('sha256')
          .update(JSON.stringify(['品牌水印']))
          .digest('hex'),
      },
    };
    const sharedPrompt = compileEffectPromptSharedPrompt(['品牌水印'], '保持产品外观一致。');
    const draft = recomputePromptQuality(
      [],
      DEFAULT_EFFECT_PROMPT_SETTINGS,
      undefined,
      renderProfile,
      sharedPrompt,
    );
    const repository = {
      result: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        revision: 3,
        draftResult: draft,
      }),
      mutateResult: vi.fn().mockResolvedValue({
        kind: 'UPDATED',
        result: {
          id: 'result-a',
          productId: 'product-a',
          revision: 4,
          savedAt: new Date('2026-08-26T08:00:00.000Z'),
          updatedAt: new Date('2026-08-26T08:00:00.000Z'),
        },
        draft,
      }),
    };
    const service = new EffectPromptService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    await service.updateSharedPrompt(
      'project-a',
      'result-a',
      3,
      '画面中不得出现以下内容：品牌水印。\n保持产品外观前后一致，并保持背景简洁。',
    );

    expect(repository.mutateResult).toHaveBeenCalledWith('project-a', 'result-a', 3, {
      kind: 'SHARED_PROMPT',
      sharedPrompt: compileEffectPromptSharedPrompt(
        ['品牌水印'],
        '保持产品外观前后一致，并保持背景简洁。',
        sharedPrompt.sections,
      ),
    });
    await expect(
      service.updateSharedPrompt('project-a', 'result-a', 3, '保持背景简洁。'),
    ).rejects.toThrow('共用提示词中的系统内容不能删除或修改');
  });

  it('returns only the node-specific metadata whitelist from the public detail API', async () => {
    const repository = {
      runForNodeDetail: vi.fn().mockResolvedValue({
        id: 'run-a',
        projectId: 'project-a',
        workflowRunId: 'workflow-a',
        productId: 'product-a',
        operation: 'BATCH_GENERATE',
        targetItemId: null,
        status: 'COMPLETED',
        progress: 100,
        currentNode: 'COMPLETED',
        warnings: [],
        errorMessage: null,
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-25T00:01:00.000Z'),
        inputSnapshot: currentInputSnapshot(),
        shards: [],
        result: null,
        stages: [
          {
            nodeId: 'RESULT_SAVE',
            status: 'SUCCEEDED',
            summary: '保存完成',
            warnings: [],
            errorMessage: null,
            updatedAt: new Date('2026-08-25T00:01:00.000Z'),
            metadata: {
              batchSize: 50,
              qualityStatus: 'PASS',
              model: 'private-model',
              promptTemplate: 'private-template',
              rawResponse: 'private-response',
              token: 'private-token',
              storageKey: 'private-storage-key',
              internalId: 'private-internal-id',
            },
          },
        ],
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.nodeDetail('project-a', 'run-a', 'RESULT_SAVE');
    expect(output.detail.fields).toEqual([
      { label: '已保存 Prompt', value: 50 },
      { label: '质量状态', value: 'PASS' },
    ]);
    expect(output.detail.blocks).toEqual([]);
    const serialized = JSON.stringify(output);
    for (const value of [
      'private-model',
      'private-template',
      'private-response',
      'private-token',
      'private-storage-key',
      'private-internal-id',
    ])
      expect(serialized).not.toContain(value);
  });

  it('rejects manual additions before they can exceed the shared result limit', async () => {
    const timestamp = '2026-08-25T00:00:00.000Z';
    const items = Array.from({ length: EFFECT_PROMPT_LIMITS.maxCount }, (_, index) => ({
      id: `item-${index}`,
      code: `P${String(index + 1).padStart(3, '0')}`,
      origin: 'AI' as const,
      fragmentType: EFFECT_PROMPT_FRAGMENT_TYPES[index % EFFECT_PROMPT_FRAGMENT_TYPES.length]!,
      primaryPurpose: EFFECT_PROMPT_FRAGMENT_TYPES[index % EFFECT_PROMPT_FRAGMENT_TYPES.length]!,
      compatiblePurposes: [
        EFFECT_PROMPT_FRAGMENT_TYPES[index % EFFECT_PROMPT_FRAGMENT_TYPES.length]!,
      ],
      classificationStatus: 'VERIFIED' as const,
      productRelevance: 80,
      materialTags: ['素材片段', `标签-${index}`],
      targetDurationSeconds: 5,
      creativeCore: `创意主线-${index}`,
      dimensions: {
        narrative: `叙事-${index}`,
        scene: `场景-${index}`,
        persona: `人物-${index}`,
        productRelation: `产品关联-${index}`,
        camera: `镜头-${index}`,
        emotion: `情绪-${index}`,
      },
      content: `家庭场景中人物拿起产品并转向镜头，近景展示外观细节 ${index}`,
      insightBindings: [],
      manualEdited: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const repository = {
      result: vi.fn().mockResolvedValue({
        draftResult: { items },
      }),
      mutateResult: vi.fn(),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    await expect(
      service.addItem('project-a', 'result-a', 1, {
        content: '新增 Prompt',
        materialTags: ['钩子', '首帧'],
        targetDurationSeconds: 5,
        dimensions: {
          narrative: '痛点前置型',
          scene: '家庭',
          persona: '都市白领',
          productRelation: '锁鲜',
          camera: '慢推近景',
          emotion: '温馨治愈',
        },
      }),
    ).rejects.toThrow(`Prompt 数量已达到 ${EFFECT_PROMPT_LIMITS.maxCount} 条上限`);
    expect(repository.mutateResult).not.toHaveBeenCalled();
  });

  it('rejects a manually edited duration outside the active render capability', async () => {
    const draftResult = completionGateFixture();
    const repository = {
      result: vi.fn().mockResolvedValue({ draftResult }),
      mutateResult: vi.fn(),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    await expect(
      service.updateItem('project-a', 'result-a', draftResult.items[0]!.id, 1, {
        content: draftResult.items[0]!.content,
        materialTags: draftResult.items[0]!.materialTags,
        targetDurationSeconds: 16,
        dimensions: draftResult.items[0]!.dimensions,
      }),
    ).rejects.toThrow('当前视频模型支持 4～15 秒的片段时长');
    expect(repository.mutateResult).not.toHaveBeenCalled();
  });

  it('combines multi-keyword search with explicit primary or compatible purpose matching', async () => {
    const timestamp = '2026-08-25T00:00:00.000Z';
    const makeItem = (
      id: string,
      fragmentType: 'HOOK' | 'CTA',
      content: string,
    ): EffectPromptItem => ({
      id,
      code: id,
      origin: 'AI' as const,
      fragmentType,
      primaryPurpose: fragmentType,
      compatiblePurposes: id === 'hook-kitchen' ? [fragmentType, 'PAIN'] : [fragmentType],
      classificationStatus: 'VERIFIED' as const,
      productRelevance: 80,
      materialTags: [fragmentType === 'HOOK' ? '首帧' : '转化'],
      targetDurationSeconds: 5,
      creativeCore: id === 'hook-kitchen' ? '用果肉悬念引出酸甜口感' : `创意主线-${id}`,
      dimensions: {
        narrative: `叙事-${id}`,
        scene: `场景-${id}`,
        persona: `人物-${id}`,
        productRelation: `产品关联-${id}`,
        camera: id === 'hook-kitchen' ? '近景缓慢推进' : `镜头-${id}`,
        emotion: `情绪-${id}`,
      },
      content,
      insightBindings:
        id === 'hook-kitchen'
          ? [
              {
                factId: 'fact-selling-point',
                field: 'CORE_SELLING_POINT' as const,
                value: '酸甜咸鲜复合口感',
                valueHash: 'a'.repeat(64),
                role: 'PRIMARY' as const,
              },
            ]
          : [],
      manualEdited: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const pendingPain: EffectPromptItem = {
      ...makeItem('pending-pain', 'CTA', '等待用途评估的人工内容'),
      fragmentType: 'PAIN',
      primaryPurpose: 'PAIN',
      compatiblePurposes: ['PAIN'],
      classificationStatus: 'PENDING',
    };
    const draftResult = recomputePromptQuality(
      [
        makeItem('hook-kitchen', 'HOOK', '家庭厨房中人物拿起产品并转向镜头'),
        makeItem('hook-outdoor', 'HOOK', '户外草地上人物打开产品并转向镜头'),
        makeItem('cta-kitchen', 'CTA', '家庭厨房中人物摆放产品并展示转化字幕'),
        pendingPain,
      ],
      DEFAULT_EFFECT_PROMPT_SETTINGS,
    );
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      latestResult: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        revision: 1,
        draftResult,
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.result(
      'project-a',
      'workflow-a',
      'product-a',
      1,
      10,
      '家庭 近景',
      'HOOK',
    );

    expect(output.total).toBe(1);
    expect(output.items.map(({ id }) => id)).toEqual(['hook-kitchen']);

    const primaryPurposeOnly = await service.result(
      'project-a',
      'workflow-a',
      'product-a',
      1,
      10,
      '',
      'PAIN',
    );
    expect(primaryPurposeOnly.total).toBe(0);

    const includingCompatiblePurpose = await service.result(
      'project-a',
      'workflow-a',
      'product-a',
      1,
      10,
      '',
      'PAIN',
      'PRIMARY_OR_COMPATIBLE',
    );
    expect(includingCompatiblePurpose.items.map(({ id }) => id)).toEqual(['hook-kitchen']);

    const businessFields = await service.result(
      'project-a',
      'workflow-a',
      'product-a',
      1,
      10,
      '果肉悬念 核心卖点 酸甜咸鲜 5秒',
    );
    expect(businessFields.items.map(({ id }) => id)).toEqual(['hook-kitchen']);

    const purposeLabel = await service.result(
      'project-a',
      'workflow-a',
      'product-a',
      1,
      10,
      '钩子片段',
    );
    expect(purposeLabel.total).toBe(2);

    const allTermsRequired = await service.result(
      'project-a',
      'workflow-a',
      'product-a',
      1,
      10,
      '家庭 户外',
    );
    expect(allTermsRequired.total).toBe(0);
  });

  it('groups the default result list by fragment workflow order before pagination', async () => {
    const timestamp = '2026-08-25T00:00:00.000Z';
    const makeItem = (
      id: string,
      code: string,
      fragmentType: (typeof EFFECT_PROMPT_FRAGMENT_TYPES)[number],
    ) => ({
      id,
      code,
      origin: 'AI' as const,
      fragmentType,
      primaryPurpose: fragmentType,
      compatiblePurposes: [fragmentType],
      classificationStatus: 'VERIFIED' as const,
      productRelevance: 80,
      materialTags: [fragmentType],
      targetDurationSeconds: 5,
      creativeCore: `创意主线-${id}`,
      dimensions: {
        narrative: `叙事-${id}`,
        scene: `场景-${id}`,
        persona: `人物-${id}`,
        productRelation: `产品关联-${id}`,
        camera: `镜头-${id}`,
        emotion: `情绪-${id}`,
      },
      content: `人物在场景中拿起产品并完成动作-${id}`,
      insightBindings: [],
      manualEdited: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const draftResult = recomputePromptQuality(
      [
        makeItem('cta', 'P003', 'CTA'),
        makeItem('hook-later', 'P010', 'HOOK'),
        makeItem('outro', 'P004', 'OUTRO'),
        makeItem('product', 'P002', 'PRODUCT_DISPLAY'),
        makeItem('hook-first', 'P001', 'HOOK'),
        makeItem('pain', 'P005', 'PAIN'),
        makeItem('selling-point', 'P006', 'SELLING_POINT_EXPLANATION'),
      ],
      DEFAULT_EFFECT_PROMPT_SETTINGS,
    );
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      latestResult: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        revision: 1,
        draftResult,
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.result('project-a', 'workflow-a', 'product-a', 1, 10);

    expect(output.items.map(({ id }) => id)).toEqual([
      'hook-first',
      'hook-later',
      'pain',
      'product',
      'selling-point',
      'cta',
      'outro',
    ]);
  });

  it('returns safe generated candidates as a read-only preview when the batch failed', async () => {
    const generatedAt = '2026-08-27T04:00:00.000Z';
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      latestResult: vi.fn().mockResolvedValue(null),
      latestFailedRunForPreview: vi.fn().mockResolvedValue({
        id: 'run-failed',
        sourceFingerprint: 'f'.repeat(64),
        inputSnapshot: {
          projectId: 'project-a',
          workflowRunId: 'workflow-a',
          productId: 'product-a',
          operation: 'BATCH_GENERATE',
          targetItemId: null,
          settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
          insightArtifact: {
            id: 'insight-a',
            revision: 1,
            contentHash: 'a'.repeat(64),
            result: { aspectRatio: '9:16', resolution: '1080P', disabledElements: ['品牌水印'] },
          },
          retainedManualItems: [],
          baseResultRevision: null,
        },
        shards: [
          {
            items: [
              {
                slotId: 'r0-s0001',
                ordinal: 1,
                fragmentType: 'HOOK',
                materialTags: ['钩子'],
                targetDurationSeconds: 5,
                creativeCore: '家庭厨房中的切面悬念',
                dimensions: {
                  narrative: '痛点前置',
                  scene: '家庭厨房',
                  persona: '穿围裙的成年人',
                  productRelation: '真实切面',
                  camera: '中近景缓慢推进',
                  emotion: '惊喜发现',
                },
                content: '家庭厨房中，成年人拿起广式腊肠转向镜头，镜头缓慢推进并停在清晰切面。',
                insightBindings: [],
                executionInvalidReasons: [],
                generatedAt,
              },
              {
                slotId: 'r0-s0003',
                ordinal: 3,
                fragmentType: 'HOOK',
                materialTags: ['钩子'],
                targetDurationSeconds: 5,
                creativeCore: '窗边桌面的细节悬念',
                dimensions: {
                  narrative: '细节悬念',
                  scene: '窗边桌面',
                  persona: '仅手部',
                  productRelation: '局部质感',
                  camera: '固定机位缓慢推进',
                  emotion: '安静好奇',
                },
                content: '窗边桌面上，一只手拿起产品，固定机位缓慢推进后停在局部细节。',
                insightBindings: [],
                executionInvalidReasons: ['PROMPT_LENGTH_MISMATCH', 'MISSING_CAMERA_EXECUTION'],
                generatedAt,
              },
              {
                slotId: 'r0-s0002',
                ordinal: 2,
                fragmentType: 'HOOK',
                materialTags: ['钩子'],
                targetDurationSeconds: 5,
                creativeCore: '餐桌上的产品悬念',
                dimensions: {
                  narrative: '悬念引入',
                  scene: '餐桌',
                  persona: '成年人',
                  productRelation: '产品外观',
                  camera: '固定近景',
                  emotion: '好奇',
                },
                content: '餐桌上产品突然漂浮，镜头跟随并展示异常画面。',
                insightBindings: [],
                executionInvalidReasons: ['PHYSICS_BREAK'],
                generatedAt,
              },
            ],
          },
        ],
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.result('project-a', 'workflow-a', 'product-a', 1, 10);

    expect(output).toMatchObject({
      resultId: null,
      revision: null,
      isPartialPreview: true,
      previewRunId: 'run-failed',
      total: 2,
    });
    expect(output.items).toHaveLength(2);
    expect(output.items[0]?.content).toContain('广式腊肠');
    expect(output.items.some(({ content }) => content.includes('窗边桌面'))).toBe(true);
    expect(output.result.qualityStatus).toBe('NEEDS_REVIEW');
  });

  it('does not recreate removed quality gates during completion', async () => {
    const draft = completionGateFixture();
    expect(draft.qualityStatus).toBe('PASS');
    const insightSnapshot = {
      id: 'insight-a',
      revision: 1,
      contentHash: 'a'.repeat(64),
      result: {},
    };
    const repository = {
      result: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        workflowRunId: 'workflow-a',
        runId: 'run-a',
        revision: 1,
        draftResult: draft,
        settingsHash: 'settings-current',
      }),
      run: vi.fn().mockResolvedValue({
        status: 'COMPLETED',
        inputSnapshot: { insightArtifact: insightSnapshot },
      }),
      insightArtifact: vi.fn().mockResolvedValue({
        ...insightSnapshot,
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      }),
      settingsNode: vi.fn().mockResolvedValue({ executionInputHash: 'settings-stale' }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.validateResult('project-a', 'result-a', 1);

    expect(output.valid).toBe(false);
    expect(output.issues).toEqual([expect.objectContaining({ code: 'STALE_RESULT' })]);
    expect(output.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EXECUTION_GATE' }),
        expect.objectContaining({ code: 'DIMENSION_DISTANCE' }),
      ]),
    );
    expect(output.warnings).toEqual([]);
  });

  it('keeps exact prompt repetition as a blocking completion issue', async () => {
    const draft = completionGateFixture(true);
    const insightSnapshot = {
      id: 'insight-a',
      revision: 1,
      contentHash: 'a'.repeat(64),
      result: {},
    };
    const repository = {
      result: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        workflowRunId: 'workflow-a',
        runId: 'run-a',
        revision: 1,
        draftResult: draft,
        settingsHash: 'settings-current',
      }),
      run: vi.fn().mockResolvedValue({
        status: 'COMPLETED',
        inputSnapshot: { insightArtifact: insightSnapshot },
      }),
      insightArtifact: vi.fn().mockResolvedValue({
        ...insightSnapshot,
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      }),
      settingsNode: vi.fn().mockResolvedValue({ executionInputHash: 'settings-stale' }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.validateResult('project-a', 'result-a', 1);

    expect(output.valid).toBe(false);
    expect(output.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'EXACT_DUPLICATE' })]),
    );
  });

  it('projects the persisted failed branch as the only failure and closes aborted siblings', async () => {
    const now = new Date('2026-08-27T04:10:00.000Z');
    const record = {
      id: 'run-a',
      projectId: 'project-a',
      workflowRunId: 'workflow-a',
      productId: 'product-a',
      operation: 'BATCH_GENERATE',
      targetItemId: null,
      inputSnapshot: currentInputSnapshot(),
      status: 'FAILED',
      progress: 80,
      currentNode: 'EXACT_SELECTION_AND_SUPPLEMENT',
      warnings: [],
      errorCode: 'AI_REQUEST_REJECTED',
      errorMessage: 'Prompt AI 请求被拒绝',
      attemptCount: 2,
      stages: [
        {
          nodeId: 'CREATIVE_EVALUATION_CLASSIFICATION',
          status: 'FAILED',
          summary: 'Prompt AI 请求被拒绝',
          warnings: [],
          errorMessage: 'Prompt AI 请求被拒绝',
        },
        {
          nodeId: 'EXACT_SELECTION_AND_SUPPLEMENT',
          status: 'RUNNING',
          summary: '正在生成候选 Prompt',
          warnings: [],
          errorMessage: null,
        },
      ],
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    const repository = { run: vi.fn().mockResolvedValue(record) };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.run('project-a', 'run-a');

    expect(output.run.currentNode).toBe('CREATIVE_EVALUATION_CLASSIFICATION');
    expect(
      output.run.nodes.find(({ nodeId }) => nodeId === 'CREATIVE_EVALUATION_CLASSIFICATION'),
    ).toMatchObject({ status: 'FAILED' });
    expect(
      output.run.nodes.find(({ nodeId }) => nodeId === 'EXACT_SELECTION_AND_SUPPLEMENT'),
    ).toMatchObject({
      status: 'SKIPPED',
      summary: '任务已停止，该分支未完成',
      errorMessage: null,
    });
  });
});
