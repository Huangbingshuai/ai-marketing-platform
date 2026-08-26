import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_LIMITS,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import { EffectPromptService } from './effect-prompt.service';
import { recomputePromptQuality } from './effect-prompt.quality';

describe('EffectPromptService settings contract', () => {
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
      run: vi.fn().mockResolvedValue({
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
      { label: '已保存 Prompt 数量', value: 50 },
      { label: '质量状态', value: 'PASS' },
    ]);
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

  it('hides V2 results from the V3 workspace and requests regeneration', async () => {
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
        errorMessage: 'Prompt 生成规则已升级，请重新生成六类素材片段',
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
      manualEdited: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const repository = {
      result: vi.fn().mockResolvedValue({
        schemaVersion: 3,
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
        schemaVersion: 3,
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
