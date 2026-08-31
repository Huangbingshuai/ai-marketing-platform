import type { EffectPromptNodeId } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { presentEffectPromptNodeDetail } from './effect-prompt-node-detail';
import type { EffectPromptNodeDetailRunRecord } from './effect-prompt.repository';

const currentNodes: EffectPromptNodeId[] = [
  'LOAD_AND_SNAPSHOT',
  'INSIGHT_MAPPING',
  'FACT_VISUAL_STRATEGY_COMPILATION',
  'SHARED_PROMPT_COMPILATION',
  'COHERENT_CREATIVE_GENERATION',
  'CREATIVE_EVALUATION_CLASSIFICATION',
  'EXACT_SELECTION_AND_SUPPLEMENT',
  'RESULT_SAVE',
];

const record = (): EffectPromptNodeDetailRunRecord =>
  ({
    id: 'run-a',
    status: 'COMPLETED',
    attemptCount: 1,
    maxAttempts: 3,
    currentNode: 'RESULT_SAVE',
    errorMessage: null,
    updatedAt: new Date('2026-08-31T01:00:00.000Z'),
    inputSnapshot: {
      selectionPolicy: 'MMR_CONTENT',
      settings: { targetCount: 2, defaultDurationSeconds: 5 },
      insightArtifact: {
        result: {
          productName: '广式腊肠',
          productCategory: '腊味肉制品',
          coreSellingPoints: ['广府糖酒腌制工艺'],
          disabledElements: ['虚构医疗功效'],
        },
      },
      retainedManualItems: [],
      sharedPrompt: {
        sections: [],
        compiledContent: '画面中不得出现虚构医疗功效。',
        contentHash: 'a'.repeat(64),
      },
    },
    stages: currentNodes.map((nodeId) => ({
      nodeId,
      status: 'SUCCEEDED',
      summary: `${nodeId} 已完成`,
      warnings: [],
      errorMessage: null,
      metadata:
        nodeId === 'RESULT_SAVE'
          ? { batchSize: 2, qualityStatus: 'PASS' }
          : nodeId === 'SHARED_PROMPT_COMPILATION'
            ? { compiledContent: '画面中不得出现虚构医疗功效。', sectionCount: 1 }
            : nodeId === 'EXACT_SELECTION_AND_SUPPLEMENT'
              ? { acceptedCount: 2, targetCount: 2, missingCount: 0 }
              : {},
      updatedAt: new Date('2026-08-31T01:00:00.000Z'),
    })),
    shards: [],
    result: null,
  }) as unknown as EffectPromptNodeDetailRunRecord;

describe('presentEffectPromptNodeDetail', () => {
  it.each(currentNodes)('只为当前工作流节点生成安全详情：%s', (nodeId) => {
    const detail = presentEffectPromptNodeDetail(record(), nodeId);
    expect(detail.nodeId).toBe(nodeId);
    expect(detail.sections.map(({ kind }) => kind)).toEqual(['INPUT', 'OUTPUT', 'EXECUTION']);
    expect(JSON.stringify(detail)).not.toContain('private');
  });

  it('把运行终态失败投影到当前节点，避免节点永久显示执行中', () => {
    const base = record();
    const failed = {
      ...base,
      status: 'FAILED',
      currentNode: 'COHERENT_CREATIVE_GENERATION',
      errorMessage: 'Prompt AI 生成超时',
      stages: base.stages.map((stage) =>
        stage.nodeId === 'COHERENT_CREATIVE_GENERATION'
          ? { ...stage, status: 'RUNNING' }
          : stage,
      ),
    } as EffectPromptNodeDetailRunRecord;
    const detail = presentEffectPromptNodeDetail(failed, 'COHERENT_CREATIVE_GENERATION');
    expect(detail.status).toBe('FAILED');
    expect(detail.errorMessage).toBe('Prompt AI 生成超时');
  });

  it('明确结果保存只是节点草稿，完成校验后才提交工作副本', () => {
    const detail = presentEffectPromptNodeDetail(record(), 'RESULT_SAVE');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');
    expect(output?.summary).toContain('节点草稿');
    expect(output?.summary).toContain('完成校验');
  });
});
