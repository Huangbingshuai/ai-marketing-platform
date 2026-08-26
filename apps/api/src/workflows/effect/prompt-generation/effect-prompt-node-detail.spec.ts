import type { EffectPromptNodeId } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { projectEffectPromptNodeMetadata } from './effect-prompt-node-detail';

describe('projectEffectPromptNodeMetadata', () => {
  it.each<{
    nodeId: EffectPromptNodeId;
    metadata: Record<string, unknown>;
    expectedLabel: string;
  }>([
    {
      nodeId: 'LOAD_AND_SNAPSHOT',
      metadata: { batchSize: 50, retainedCount: 2 },
      expectedLabel: '目标批次数量',
    },
    {
      nodeId: 'STRATEGY_PLANNING',
      metadata: { narrativeCount: 6, dimensionExample: '痛点前置 / 家庭 / 新手妈妈' },
      expectedLabel: '叙事结构候选数',
    },
    {
      nodeId: 'DIMENSION_COMBINATION',
      metadata: { plannedCandidateCount: 63, combinationExample: '家庭 × 新手妈妈 × 近景' },
      expectedLabel: '计划候选数',
    },
    {
      nodeId: 'FRAGMENT_TYPE_ROUTER',
      metadata: { fragmentTypeCount: 6, totalShards: 9, routedShards: 9 },
      expectedLabel: '路由片段类型数',
    },
    {
      nodeId: 'GENERATE_HOOK',
      metadata: { totalShards: 8, completedShards: 5, candidateExample: '片段类型 + 六维 + 正文' },
      expectedLabel: '分片总数',
    },
    {
      nodeId: 'NORMALIZATION',
      metadata: { candidateCount: 50, normalizedFieldCount: 9 },
      expectedLabel: '标准化 Prompt 数量',
    },
    {
      nodeId: 'SEMANTIC_DEDUP',
      metadata: { comparedPairCount: 1225, violatingPairCount: 20, semanticDuplicateRate: 1.63 },
      expectedLabel: '语义相似 Prompt 对数',
    },
    {
      nodeId: 'VISUAL_DEDUP',
      metadata: { comparedPairCount: 1225, violatingPairCount: 30, visualOverlapRate: 2.45 },
      expectedLabel: '视觉重合 Prompt 对数',
    },
    {
      nodeId: 'QUALITY_GATE',
      metadata: { acceptedCount: 50, targetCount: 50, qualityStatus: 'PASS' },
      expectedLabel: '通过数量',
    },
    {
      nodeId: 'REPLENISH',
      metadata: { replenishmentRound: 2, missingCount: 4, plannedCandidateCount: 5 },
      expectedLabel: '补齐轮次',
    },
    {
      nodeId: 'RESULT_SAVE',
      metadata: { batchSize: 50, qualityStatus: 'PASS' },
      expectedLabel: '已保存 Prompt 数量',
    },
  ])('projects safe fields for $nodeId', ({ nodeId, metadata, expectedLabel }) => {
    expect(projectEffectPromptNodeMetadata(nodeId, metadata)).toContainEqual(
      expect.objectContaining({ label: expectedLabel }),
    );
  });

  it('drops malicious, unknown, nested, and invalid metadata values', () => {
    const fields = projectEffectPromptNodeMetadata('RESULT_SAVE', {
      batchSize: 50,
      qualityStatus: 'PASS',
      model: 'secret-model',
      promptTemplate: 'system prompt secret',
      rawResponse: '{full paid model response}',
      token: 'worker-token-secret',
      storageKey: 'private/storage/location',
      internalId: 'internal-run-id',
      saveSummary: { nested: 'must not escape' },
      resultRevision: 3,
      unknown: 'unknown-secret',
    });
    const serialized = JSON.stringify(fields);

    expect(fields).toEqual([
      { label: '已保存 Prompt 数量', value: 50 },
      { label: '质量状态', value: 'PASS' },
    ]);
    for (const secret of [
      'secret-model',
      'system prompt secret',
      'full paid model response',
      'worker-token-secret',
      'private/storage/location',
      'internal-run-id',
      'must not escape',
      'unknown-secret',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('does not project unknown metadata keys and returns only a fixed safe example', () => {
    expect(
      projectEffectPromptNodeMetadata('LOAD_AND_SNAPSHOT', {
        randomCount: 99,
        opaquePayload: 'do not show',
      }),
    ).toEqual([
      {
        label: '快照内容',
        value: '营销洞察、批次设置与人工保留项',
        description: '不展示模型输入正文',
      },
    ]);
  });
});
