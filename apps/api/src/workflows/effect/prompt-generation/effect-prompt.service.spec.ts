import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_SCHEMA_VERSION,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import { EffectPromptService } from './effect-prompt.service';
import { recomputePromptQuality } from './effect-prompt.quality';

describe('EffectPromptService settings contract', () => {
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

  it('rejects a structurally valid batch that is shorter than the saved six-type quota', async () => {
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
      complete: vi.fn(),
    };
    const service = new EffectPromptService(repository as never, {} as never, {} as never);

    await expect(
      service.complete('project-a', 'run-a', 'attempt-a', { result: shortResult }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Prompt 成功结果必须严格满足用户设置的总数量和六类片段配额',
    });
    expect(repository.complete).not.toHaveBeenCalled();
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
});
