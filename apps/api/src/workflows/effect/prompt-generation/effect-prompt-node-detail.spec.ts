import { EFFECT_PROMPT_GRAPH_NODES } from '@ai-marketing/contracts';

import {
  EffectPromptRepository,
  type EffectPromptNodeDetailRunRecord,
} from './effect-prompt.repository';
import { describe, expect, it, vi } from 'vitest';

import { presentEffectPromptNodeDetail } from './effect-prompt-node-detail';

const dimensions = {
  narrative: '痛点前置型',
  scene: '家庭厨房的煲仔饭操作台',
  persona: '一位35岁左右、穿米色家居服的女性',
  sellingPoint: '适配煲仔饭等多种烹饪方式',
  camera: '肩后中近景缓慢推进',
  emotion: '温馨治愈的舒缓节奏',
};

const prompt = (ordinal: number, content = '木筷夹起一片广式腊肠，切面朝向镜头并停住。') => ({
  slotId: `private-slot-${ordinal}`,
  ordinal,
  fragmentType: 'HOOK',
  materialTags: ['钩子', '首帧'],
  targetDurationSeconds: 5,
  dimensions,
  content,
  executionInvalidReasons: [],
});

const runRecord = (): EffectPromptNodeDetailRunRecord =>
  ({
    id: 'run-a',
    inputSnapshot: {
      schemaVersion: 4,
      settings: {
        fragmentConfigs: {
          HOOK: { count: 10, durationSeconds: 5 },
          PAIN: { count: 8, durationSeconds: 5 },
          PRODUCT_DISPLAY: { count: 12, durationSeconds: 5 },
          SELLING_POINT_EXPLANATION: { count: 10, durationSeconds: 5 },
          CTA: { count: 6, durationSeconds: 5 },
          OUTRO: { count: 4, durationSeconds: 5 },
        },
        semanticLimit: 15,
        visualLimit: 20,
      },
      insightArtifact: {
        result: {
          productName: '广式腊肠',
          productCategory: '腊味肉制品',
          coreSellingPoints: ['三七肥瘦黄金配比', '广府糖酒腌制工艺'],
          disabledElements: ['未成年人', '价格促销'],
        },
      },
      retainedManualItems: [],
    },
    stages: [
      {
        nodeId: 'LOAD_AND_SNAPSHOT',
        status: 'SUCCEEDED',
        summary: '输入快照已锁定',
        warnings: [],
        errorMessage: null,
        metadata: { batchSize: 50, model: 'private-model' },
        updatedAt: new Date('2026-08-26T00:00:00.000Z'),
      },
      {
        nodeId: 'STRATEGY_PLANNING',
        status: 'SUCCEEDED',
        summary: '规划完成',
        warnings: [],
        errorMessage: null,
        metadata: {
          relationshipBundleCount: 14,
          modelRelationshipBundleCount: 10,
          workerCompletedRelationshipBundleCount: 4,
          plannedFactCount: 22,
          rawResponse: 'private-response',
        },
        updatedAt: new Date('2026-08-26T00:00:01.000Z'),
      },
      {
        nodeId: 'GENERATE_HOOK',
        status: 'SUCCEEDED',
        summary: '钩子生成完成',
        warnings: [],
        errorMessage: null,
        metadata: { targetCount: 10, candidateCount: 4, token: 'private-token' },
        updatedAt: new Date('2026-08-26T00:00:02.000Z'),
      },
      {
        nodeId: 'SEMANTIC_DEDUP',
        status: 'SUCCEEDED',
        summary: '语义校验完成',
        warnings: [],
        errorMessage: null,
        metadata: { comparedPairCount: 6, violatingPairCount: 1, semanticDuplicateRate: 16.67 },
        updatedAt: new Date('2026-08-26T00:00:03.000Z'),
      },
    ],
    shards: [
      {
        phase: 'PROMPT',
        round: 0,
        shardIndex: 0,
        status: 'SUCCEEDED',
        combinationPlan: Array.from({ length: 4 }, (_, index) => ({
          ordinal: index + 1,
          fragmentType: 'HOOK',
          targetDurationSeconds: 5,
          dimensions,
          visibleAction: '右手拿起产品并把正面转向镜头',
          evidenceMode: 'USAGE_ACTION',
          slotId: `private-slot-${index + 1}`,
        })),
        items: [
          prompt(1),
          prompt(2),
          prompt(
            3,
            `5秒，3:4竖屏。木筷夹起一片广式腊肠，切面朝向镜头并停住。https://secret.example/private ${'A'.repeat(260)}`,
          ),
          prompt(4, '访问 https://secret.example/private 后展示产品。'),
        ],
      },
    ],
    result: null,
  }) as unknown as EffectPromptNodeDetailRunRecord;

describe('presentEffectPromptNodeDetail', () => {
  it('projects a terminal run failure over a stale running stage', () => {
    const record = runRecord();
    const failed = {
      ...record,
      status: 'FAILED',
      currentNode: 'STRATEGY_PLANNING',
      errorMessage: 'Prompt AI 生成超时',
      updatedAt: new Date('2026-08-26T00:05:00.000Z'),
      stages: record.stages.map((stage) =>
        stage.nodeId === 'STRATEGY_PLANNING' ? { ...stage, status: 'RUNNING' } : stage,
      ),
    } as EffectPromptNodeDetailRunRecord;

    const detail = presentEffectPromptNodeDetail(failed, 'STRATEGY_PLANNING');

    expect(detail.status).toBe('FAILED');
    expect(detail.errorMessage).toBe('Prompt AI 生成超时');
    expect(detail.updatedAt).toBe('2026-08-26T00:05:00.000Z');
  });

  it('loads shard bodies only for the project-scoped node detail query', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectPromptRepository({
      effectPromptRun: { findFirst },
    } as never);

    await repository.runForNodeDetail('project-a', 'run-a');
    await repository.run('project-a', 'run-a');

    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { projectId: 'project-a', id: 'run-a' },
      include: { shards: expect.any(Object) },
    });
    expect(findFirst.mock.calls[1]?.[0]).toMatchObject({
      where: { projectId: 'project-a', id: 'run-a' },
    });
    expect(findFirst.mock.calls[1]?.[0].include).not.toHaveProperty('shards');
  });

  it.each(EFFECT_PROMPT_GRAPH_NODES.map(({ id }) => id))(
    'projects a safe detail response for %s',
    (nodeId) => {
      const detail = presentEffectPromptNodeDetail(runRecord(), nodeId);
      expect(detail.nodeId).toBe(nodeId);
      expect(detail.blocks.every((block) => block.title.length > 0)).toBe(true);
      expect(JSON.stringify(detail)).not.toMatch(
        /private-model|private-response|private-token|private-slot/u,
      );
    },
  );

  it('projects actual snapshot facts and inherited business constraints', () => {
    const detail = presentEffectPromptNodeDetail(runRecord(), 'LOAD_AND_SNAPSHOT');
    expect(detail.fields).toContainEqual({ label: '产品名称', value: '广式腊肠' });
    expect(detail.fields).toContainEqual({ label: '产品品类', value: '腊味肉制品' });
    expect(detail.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'TAG_LIST',
        groups: expect.arrayContaining([
          expect.objectContaining({
            label: '核心卖点',
            values: ['三七肥瘦黄金配比', '广府糖酒腌制工艺'],
          }),
        ]),
      }),
    );
  });

  it('uses persisted combinations instead of a fixed strategy example', () => {
    const detail = presentEffectPromptNodeDetail(runRecord(), 'STRATEGY_PLANNING');
    expect(detail.fields).toContainEqual({ label: '营销关系束', value: 14 });
    expect(detail.fields).toContainEqual({ label: '模型有效规划', value: 10 });
    expect(detail.fields).toContainEqual({ label: '系统安全补齐', value: 4 });
    expect(detail.fields).toContainEqual({ label: '已规划事实', value: 22 });
    expect(JSON.stringify(detail.blocks)).toContain('家庭厨房的煲仔饭操作台');
    expect(JSON.stringify(detail.blocks)).toContain('右手拿起产品并把正面转向镜头');
    expect(JSON.stringify(detail.blocks)).not.toContain('仅展示固定业务示例');
  });

  it('returns at most three real prompt samples and sanitizes links', () => {
    const detail = presentEffectPromptNodeDetail(runRecord(), 'GENERATE_HOOK');
    const promptBlock = detail.blocks.find((block) => block.kind === 'PROMPT_LIST');
    expect(promptBlock?.kind).toBe('PROMPT_LIST');
    if (promptBlock?.kind !== 'PROMPT_LIST') throw new Error('missing prompt block');
    expect(promptBlock.items).toHaveLength(3);
    expect(promptBlock.items[0]?.content).toContain('木筷夹起一片广式腊肠');
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('secret.example');
    expect(serialized).not.toContain('A'.repeat(260));
    expect(serialized).not.toContain('private-slot');
  });

  it('shows actual violating pairs without leaking private stage metadata', () => {
    const detail = presentEffectPromptNodeDetail(runRecord(), 'SEMANTIC_DEDUP');
    const pairBlock = detail.blocks.find((block) => block.kind === 'PAIR_LIST');
    expect(pairBlock?.kind).toBe('PAIR_LIST');
    if (pairBlock?.kind !== 'PAIR_LIST') throw new Error('missing pair block');
    expect(pairBlock.items[0]?.score).toBeGreaterThanOrEqual(0.82);
    expect(pairBlock.items[0]?.left.content).toContain('广式腊肠');
    const serialized = JSON.stringify(detail);
    for (const secret of ['private-model', 'private-response', 'private-token', 'private-slot'])
      expect(serialized).not.toContain(secret);
  });

  it('projects V10 relationship, coordinate, blueprint, and orthogonal results from checkpoints', () => {
    const base = runRecord();
    const coreFactId = 'CORE_SELLING_POINT:21e0d2c4d474f48798bd';
    const plan = {
      fragmentType: 'HOOK',
      narratives: [
        {
          coordinateId: 'N1',
          value: '从反常细节建立悬念',
          compatibleBundleIds: ['H1'],
          sourceFactIds: [],
        },
      ],
      scenes: [
        {
          coordinateId: 'S1',
          value: '年节家庭厨房',
          compatibleBundleIds: ['H1'],
          sourceFactIds: [],
        },
      ],
      personas: [
        {
          coordinateId: 'P1',
          value: '只出现成年人的双手',
          compatibleBundleIds: ['H1'],
          sourceFactIds: [],
        },
      ],
      sellingPoints: [
        {
          coordinateId: 'SP1',
          value: '三七肥瘦黄金配比',
          compatibleBundleIds: ['H1'],
          sourceFactIds: [coreFactId],
        },
      ],
      cameras: [
        {
          coordinateId: 'C1',
          value: '桌面高度近景平稳靠近',
          compatibleBundleIds: ['H1'],
          sourceFactIds: [],
        },
      ],
      emotions: [
        {
          coordinateId: 'E1',
          value: '暖色食欲感',
          compatibleBundleIds: ['H1'],
          sourceFactIds: [],
        },
      ],
    };
    const v10 = {
      ...base,
      inputSnapshot: {
        ...(base.inputSnapshot as Record<string, unknown>),
        graphVersion: 'V10_RELATION_COORDINATE_BLUEPRINT',
      },
      stages: [
        ...base.stages,
        {
          nodeId: 'PLAN_HOOK_RELATIONSHIPS',
          status: 'SUCCEEDED',
          summary: '钩子营销组合完成',
          warnings: [],
          errorMessage: null,
          metadata: {
            checkpoint: {
              plan: {
                fragmentType: 'HOOK',
                bundles: [
                  {
                    bundleId: 'H1',
                    fragmentType: 'HOOK',
                    primaryFactId: coreFactId,
                    factIds: [coreFactId],
                    creativeIntent: '以产品切面细节建立首秒悬念',
                  },
                ],
              },
            },
          },
          updatedAt: new Date('2026-08-27T01:00:00.000Z'),
        },
        {
          nodeId: 'PLAN_HOOK_COORDINATES',
          status: 'SUCCEEDED',
          summary: '钩子坐标完成',
          warnings: [],
          errorMessage: null,
          metadata: { checkpoint: { plan } },
          updatedAt: new Date('2026-08-27T01:00:01.000Z'),
        },
        {
          nodeId: 'BLUEPRINT_ORTHOGONAL_GATE',
          status: 'SUCCEEDED',
          summary: '全批次蓝图校验完成',
          warnings: [],
          errorMessage: null,
          metadata: { comparedPairCount: 1, rejectedCount: 1 },
          updatedAt: new Date('2026-08-27T01:00:02.000Z'),
        },
      ],
      shards: [
        ...base.shards,
        {
          phase: 'BLUEPRINT',
          round: 0,
          shardIndex: 0,
          status: 'SUCCEEDED',
          combinationPlan: [1, 2].map((ordinal) => ({
            slotId: `blueprint-private-${ordinal}`,
            ordinal,
            fragmentType: 'HOOK',
            bundleId: 'H1',
            targetDurationSeconds: 5,
          })),
          items: [1, 2].map((ordinal) => ({
            slotId: `blueprint-private-${ordinal}`,
            fragmentType: 'HOOK',
            bundleId: 'H1',
            narrativeCoordinateId: 'N1',
            sceneCoordinateId: 'S1',
            personaCoordinateId: 'P1',
            sellingPointCoordinateId: 'SP1',
            cameraCoordinateId: 'C1',
            emotionCoordinateId: 'E1',
            openingState: '切开的广式腊肠位于画面中央',
            actionArc: '木筷夹起切片并停住',
            endingState: '切面稳定朝向镜头',
          })),
        },
      ],
    } as unknown as EffectPromptNodeDetailRunRecord;

    const relationship = presentEffectPromptNodeDetail(v10, 'PLAN_HOOK_RELATIONSHIPS');
    const coordinate = presentEffectPromptNodeDetail(v10, 'PLAN_HOOK_COORDINATES');
    const blueprint = presentEffectPromptNodeDetail(v10, 'GENERATE_HOOK_BLUEPRINTS');
    const orthogonal = presentEffectPromptNodeDetail(v10, 'BLUEPRINT_ORTHOGONAL_GATE');

    expect(relationship.blocks).toContainEqual(
      expect.objectContaining({ kind: 'RELATIONSHIP_LIST' }),
    );
    expect(coordinate.blocks).toContainEqual(expect.objectContaining({ kind: 'COORDINATE_LIST' }));
    expect(blueprint.blocks).toContainEqual(expect.objectContaining({ kind: 'BLUEPRINT_LIST' }));
    expect(orthogonal.blocks).toContainEqual(
      expect.objectContaining({ kind: 'ORTHOGONAL_PAIR_LIST' }),
    );
    expect(JSON.stringify(blueprint)).not.toContain('blueprint-private');
  });
});
