import { createHash } from 'node:crypto';

import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_SCHEMA_VERSION,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import { EffectPromptService } from './effect-prompt.service';
import { compileEffectPromptSharedPrompt, recomputePromptQuality } from './effect-prompt.quality';

const completionGateFixture = (duplicate = false) => {
  const settings = structuredClone(DEFAULT_EFFECT_PROMPT_SETTINGS);
  for (const fragmentType of EFFECT_PROMPT_FRAGMENT_TYPES)
    settings.fragmentConfigs[fragmentType].count = fragmentType === 'HOOK' ? 5 : 1;
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
    materialTags: [fragmentType, String(index)],
    targetDurationSeconds: 5,
    dimensions: {
      narrative: `叙事-${index}`,
      scene: index === 1 ? '场景-0' : `场景-${index}`,
      persona: index === 1 ? '人物-0' : `人物-${index}`,
      sellingPoint: `抽象品质-${index}`,
      camera: index === 1 ? '镜头-0' : `镜头-${index}`,
      emotion: index === 1 ? '情绪-0' : `情绪-${index}`,
    },
    content: contents[index]!,
    insightBindings: [],
    manualEdited: false,
    createdAt: now,
    updatedAt: now,
  }));
  return recomputePromptQuality(items, settings);
};

describe('EffectPromptService settings contract', () => {
  it('returns V9-compatible strategy checkpoints and unified V10 stage checkpoints on claim', async () => {
    const relationshipCheckpoint = {
      nodeId: 'PLAN_HOOK_RELATIONSHIPS',
      sourceFingerprint: 'source-a',
      allocationHash: 'a'.repeat(64),
      promptVersion: 'v10',
      plan: {},
    };
    const strategyCheckpoint = {
      nodeId: 'PLAN_HOOK_STRATEGY',
      sourceFingerprint: 'source-a',
      allocationHash: 'b'.repeat(64),
      promptVersion: 'v9',
      plan: {},
    };
    const repository = {
      claim: vi.fn().mockResolvedValue({
        kind: 'CLAIMED',
        run: { sourceFingerprint: 'source-a' },
        attemptToken: 'attempt-a',
        input: { graphVersion: 'V10_RELATION_COORDINATE_BLUEPRINT' },
        checkpointStages: [
          {
            nodeId: 'PLAN_HOOK_RELATIONSHIPS',
            metadata: { checkpoint: relationshipCheckpoint },
          },
          { nodeId: 'PLAN_HOOK_STRATEGY', metadata: { checkpoint: strategyCheckpoint } },
        ],
      }),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    const output = await service.claim('project-a', 'run-a');

    expect(output).toMatchObject({
      terminal: false,
      stageCheckpoints: [relationshipCheckpoint, strategyCheckpoint],
      strategyCheckpoints: [strategyCheckpoint],
    });
  });
  it('normalizes and forwards visual item-regeneration direction without opening a batch path', async () => {
    const dimensions = {
      narrative: ' 场景代入型 ',
      scene: ' 家庭餐桌 ',
      persona: ' 仅手部出镜 ',
      sellingPoint: ' 单手开合 ',
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
        replacementDimensions: {
          narrative: '场景代入型',
          scene: '家庭餐桌',
          persona: '仅手部出镜',
          sellingPoint: '单手开合',
          camera: '桌面近景缓慢推进',
          emotion: '温暖舒缓',
        },
      }),
    );
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
          materialTags: ['钩子'],
          targetDurationSeconds: 5,
          dimensions: {
            narrative: '痛点前置',
            scene: '家庭厨房',
            persona: '穿围裙的成年人',
            sellingPoint: '真实切面',
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
          operation: 'BATCH_GENERATE',
          settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
        },
      }),
      complete: vi.fn().mockResolvedValue({ kind: 'COMPLETED', result: { id: 'result-a' } }),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    await expect(
      service.complete('project-a', 'run-a', 'attempt-a', { result: shortResult }),
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

  it('saves the single shared-prompt editor content and keeps the batch in draft', async () => {
    const draft = recomputePromptQuality([], DEFAULT_EFFECT_PROMPT_SETTINGS);
    const savedAt = new Date('2026-08-26T08:00:00.000Z');
    const repository = {
      result: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        revision: 3,
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
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
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
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
        inputSnapshot: {},
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

  it('hides V2 results from the V4 workspace and requests regeneration', async () => {
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      products: vi.fn().mockResolvedValue([
        {
          id: 'product-a',
          promptRuns: [],
          updatedAt: new Date('2026-08-25T00:00:00.000Z'),
        },
      ]),
      latestResult: vi.fn().mockResolvedValue({
        id: 'legacy-result',
        revision: 4,
        schemaVersion: 2,
        settingsHash: 'legacy-settings',
        draftResult: { schemaVersion: 2 },
      }),
      settingsNode: vi.fn().mockResolvedValue({
        revision: 2,
        schemaVersion: 2,
        state: { count: 50, durationSeconds: 5, semanticLimit: 15, visualLimit: 20 },
      }),
      insightArtifact: vi.fn().mockResolvedValue(null),
      promptArtifact: vi.fn().mockResolvedValue(null),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.workspace('project-a', 'workflow-a');

    expect(output.products[0]).toEqual(
      expect.objectContaining({
        resultId: null,
        resultRevision: null,
        metrics: null,
        qualityStatus: null,
        errorMessage: 'Prompt 生成规则已升级；旧的 3 秒设置会在重新生成时调整为当前模型允许的 4 秒',
      }),
    );
  });

  it('keeps a replacement batch visible as processing while its legacy result is stale', async () => {
    const activeRun = {
      id: 'run-new',
      status: 'RUNNING',
      progress: 11,
      currentNode: 'STRATEGY_PLANNING',
      result: null,
      updatedAt: new Date('2026-08-26T00:01:00.000Z'),
    };
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      products: vi.fn().mockResolvedValue([
        {
          id: 'product-a',
          promptRuns: [activeRun],
          updatedAt: new Date('2026-08-26T00:00:00.000Z'),
        },
      ]),
      run: vi.fn().mockImplementation((_projectId: string, id: string) =>
        Promise.resolve(
          id === activeRun.id
            ? activeRun
            : {
                id: 'run-old',
                inputSnapshot: {},
              },
        ),
      ),
      latestResult: vi.fn().mockResolvedValue({
        id: 'legacy-result',
        runId: 'run-old',
        revision: 4,
        schemaVersion: 2,
        settingsHash: 'legacy-settings',
        draftResult: { schemaVersion: 2 },
      }),
      settingsNode: vi.fn().mockResolvedValue({
        revision: 2,
        schemaVersion: 2,
        state: { count: 50, durationSeconds: 5, semanticLimit: 15, visualLimit: 20 },
      }),
      insightArtifact: vi.fn().mockResolvedValue(null),
      promptArtifact: vi.fn().mockResolvedValue(null),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.workspace('project-a', 'workflow-a');

    expect(output.products[0]).toEqual(
      expect.objectContaining({
        status: 'PROCESSING',
        runId: 'run-new',
        progress: 11,
        currentNode: 'STRATEGY_PLANNING',
      }),
    );
  });

  it('rejects manual additions before they can exceed the shared result limit', async () => {
    const timestamp = '2026-08-25T00:00:00.000Z';
    const items = Array.from({ length: EFFECT_PROMPT_LIMITS.maxCount }, (_, index) => ({
      id: `item-${index}`,
      code: `P${String(index + 1).padStart(3, '0')}`,
      origin: 'AI' as const,
      fragmentType: EFFECT_PROMPT_FRAGMENT_TYPES[index % EFFECT_PROMPT_FRAGMENT_TYPES.length]!,
      materialTags: ['素材片段', `标签-${index}`],
      targetDurationSeconds: 5,
      dimensions: {
        narrative: `叙事-${index}`,
        scene: `场景-${index}`,
        persona: `人物-${index}`,
        sellingPoint: `卖点-${index}`,
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
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
        draftResult: { items },
      }),
      mutateResult: vi.fn(),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    await expect(
      service.addItem('project-a', 'result-a', 1, {
        content: '新增 Prompt',
        fragmentType: 'HOOK',
        materialTags: ['钩子', '首帧'],
        dimensions: {
          narrative: '痛点前置型',
          scene: '家庭',
          persona: '都市白领',
          sellingPoint: '锁鲜',
          camera: '慢推近景',
          emotion: '温馨治愈',
        },
      }),
    ).rejects.toThrow(`Prompt 数量已达到 ${EFFECT_PROMPT_LIMITS.maxCount} 条上限`);
    expect(repository.mutateResult).not.toHaveBeenCalled();
  });

  it('combines full-text search with the strict fragment-type filter', async () => {
    const timestamp = '2026-08-25T00:00:00.000Z';
    const makeItem = (id: string, fragmentType: 'HOOK' | 'CTA', content: string) => ({
      id,
      code: id,
      origin: 'AI' as const,
      fragmentType,
      materialTags: [fragmentType === 'HOOK' ? '钩子' : '转化'],
      targetDurationSeconds: 5,
      dimensions: {
        narrative: `叙事-${id}`,
        scene: `场景-${id}`,
        persona: `人物-${id}`,
        sellingPoint: `卖点-${id}`,
        camera: `镜头-${id}`,
        emotion: `情绪-${id}`,
      },
      content,
      insightBindings: [],
      manualEdited: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const draftResult = recomputePromptQuality(
      [
        makeItem('hook-kitchen', 'HOOK', '家庭厨房中人物拿起产品并转向镜头'),
        makeItem('hook-outdoor', 'HOOK', '户外草地上人物打开产品并转向镜头'),
        makeItem('cta-kitchen', 'CTA', '家庭厨房中人物摆放产品并展示转化字幕'),
      ],
      DEFAULT_EFFECT_PROMPT_SETTINGS,
    );
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      latestResult: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        revision: 1,
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
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
      '家庭厨房',
      'HOOK',
    );

    expect(output.total).toBe(1);
    expect(output.items.map(({ id }) => id)).toEqual(['hook-kitchen']);
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
      materialTags: [fragmentType],
      targetDurationSeconds: 5,
      dimensions: {
        narrative: `叙事-${id}`,
        scene: `场景-${id}`,
        persona: `人物-${id}`,
        sellingPoint: `卖点-${id}`,
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
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
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
          schemaVersion: 5,
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
                dimensions: {
                  narrative: '痛点前置',
                  scene: '家庭厨房',
                  persona: '穿围裙的成年人',
                  sellingPoint: '真实切面',
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
                dimensions: {
                  narrative: '细节悬念',
                  scene: '窗边桌面',
                  persona: '仅手部',
                  sellingPoint: '局部质感',
                  camera: '固定机位缓慢推进',
                  emotion: '安静好奇',
                },
                content: '窗边桌面上，一只手拿起产品，固定机位缓慢推进后停在局部细节。',
                insightBindings: [],
                executionInvalidReasons: [
                  'PROMPT_LENGTH_MISMATCH',
                  'MISSING_CAMERA_EXECUTION',
                ],
                generatedAt,
              },
              {
                slotId: 'r0-s0002',
                ordinal: 2,
                fragmentType: 'HOOK',
                materialTags: ['钩子'],
                targetDurationSeconds: 5,
                dimensions: {
                  narrative: '悬念引入',
                  scene: '餐桌',
                  persona: '成年人',
                  sellingPoint: '产品外观',
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

  it('returns an explicit validation issue for legacy full-video results', async () => {
    const repository = {
      result: vi.fn().mockResolvedValue({
        id: 'result-a',
        productId: 'product-a',
        revision: 1,
        schemaVersion: 1,
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    const output = await service.validateResult('project-a', 'result-a', 1);

    expect(output.valid).toBe(false);
    expect(output.issues).toEqual([expect.objectContaining({ code: 'LEGACY_SCHEMA' })]);
  });

  it('keeps soft prompt refinements as warnings in the completion gate', async () => {
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
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
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
    expect(output.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SOFT_QUALITY_WARNING' })]),
    );
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
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
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

  it('recognizes a versionless recovered run as V9 when real V9 stages exist', async () => {
    const now = new Date('2026-08-27T03:00:00.000Z');
    const record = {
      id: 'run-a',
      projectId: 'project-a',
      workflowRunId: 'workflow-a',
      productId: 'product-a',
      operation: 'BATCH_GENERATE',
      targetItemId: null,
      inputSnapshot: {},
      status: 'FAILED',
      progress: 15,
      currentNode: 'GLOBAL_FACT_ALLOCATION',
      warnings: [],
      errorCode: null,
      errorMessage: null,
      attemptCount: 1,
      stages: [
        {
          nodeId: 'GLOBAL_FACT_ALLOCATION',
          status: 'SUCCEEDED',
          summary: '全局事实分配完成',
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

    expect(output.run.graphVersion).toBe('V9_SIX_BRANCH_STRATEGY');
    expect(output.run.nodes.some(({ nodeId }) => nodeId === 'GLOBAL_FACT_ALLOCATION')).toBe(true);
    expect(output.run.nodes.some(({ nodeId }) => nodeId === 'STRATEGY_PLANNING')).toBe(false);
  });

  it('recognizes a versionless recovered run as V10 when V10-only stages exist', async () => {
    const now = new Date('2026-08-27T03:30:00.000Z');
    const record = {
      id: 'run-v10',
      projectId: 'project-a',
      workflowRunId: 'workflow-a',
      productId: 'product-a',
      operation: 'BATCH_GENERATE',
      targetItemId: null,
      inputSnapshot: {},
      status: 'RUNNING',
      progress: 30,
      currentNode: 'PLAN_HOOK_COORDINATES',
      warnings: [],
      errorCode: null,
      errorMessage: null,
      attemptCount: 1,
      stages: [
        {
          nodeId: 'PLAN_HOOK_COORDINATES',
          status: 'SUCCEEDED',
          summary: '钩子六维坐标规划完成',
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

    const output = await service.run('project-a', 'run-v10');

    expect(output.run.graphVersion).toBe('V10_RELATION_COORDINATE_BLUEPRINT');
    expect(output.run.nodes.some(({ nodeId }) => nodeId === 'PLAN_HOOK_COORDINATES')).toBe(true);
    expect(output.run.nodes.some(({ nodeId }) => nodeId === 'PLAN_HOOK_STRATEGY')).toBe(false);
  });

  it('rejects node details from a different persisted graph version', async () => {
    const now = new Date('2026-08-27T03:40:00.000Z');
    const record = {
      id: 'run-v9',
      inputSnapshot: { graphVersion: 'V9_SIX_BRANCH_STRATEGY' },
      status: 'COMPLETED',
      currentNode: 'COMPLETED',
      stages: [],
      shards: [],
      result: null,
      updatedAt: now,
    };
    const repository = { runForNodeDetail: vi.fn().mockResolvedValue(record) };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new EffectPromptService(repository as never, projects as never, {} as never);

    await expect(
      service.nodeDetail('project-a', 'run-v9', 'PLAN_HOOK_COORDINATES'),
    ).rejects.toMatchObject({ status: 400 });
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
      inputSnapshot: { graphVersion: 'V9_SIX_BRANCH_STRATEGY' },
      status: 'FAILED',
      progress: 80,
      currentNode: 'GENERATE_OUTRO',
      warnings: [],
      errorCode: 'AI_REQUEST_REJECTED',
      errorMessage: 'Prompt AI 请求被拒绝',
      attemptCount: 2,
      stages: [
        {
          nodeId: 'GENERATE_PRODUCT_DISPLAY',
          status: 'FAILED',
          summary: 'Prompt AI 请求被拒绝',
          warnings: [],
          errorMessage: 'Prompt AI 请求被拒绝',
        },
        {
          nodeId: 'GENERATE_OUTRO',
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

    expect(output.run.currentNode).toBe('GENERATE_PRODUCT_DISPLAY');
    expect(
      output.run.nodes.find(({ nodeId }) => nodeId === 'GENERATE_PRODUCT_DISPLAY'),
    ).toMatchObject({ status: 'FAILED' });
    expect(output.run.nodes.find(({ nodeId }) => nodeId === 'GENERATE_OUTRO')).toMatchObject({
      status: 'SKIPPED',
      summary: '任务已停止，该分支未完成',
      errorMessage: null,
    });
  });
});
