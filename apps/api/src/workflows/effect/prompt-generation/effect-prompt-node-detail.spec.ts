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
        metadata: { sceneCount: 17, rawResponse: 'private-response' },
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
    expect(detail.fields).toContainEqual({ label: '场景方案', value: 17 });
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
});
