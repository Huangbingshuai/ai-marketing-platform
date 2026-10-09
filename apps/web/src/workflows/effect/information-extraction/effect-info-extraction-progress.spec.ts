import type {
  EffectExtractionNodeExecution,
  EffectExtractionNodeId,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { extractionProgressMessage } from './effect-info-extraction-progress';

const node = (
  nodeId: EffectExtractionNodeId,
  status: EffectExtractionNodeExecution['status'],
): EffectExtractionNodeExecution => ({ nodeId, status, warnings: [], errorMessage: null });
const processing = (currentNode: string | null) => ({ status: 'PROCESSING' as const, currentNode });

describe('extraction progress messages', () => {
  it('shows Chinese processing information for every stage and unknown historical values', () => {
    const messages = {
      LOAD_AND_SNAPSHOT: '正在准备本次产品资料',
      DOCUMENT: '正在解析产品文档',
      IMAGE: '正在识别商品图片',
      COMMERCE: '正在读取电商商品信息',
      FUSION: '正在合并多来源产品信息',
      SEMANTIC_REFINEMENT: '正在核对图片补充与已有卖点',
      NORMALIZATION: '正在整理并保存产品信息卡',
      COMPLETED: '正在同步提炼结果',
    };
    for (const [stage, message] of Object.entries(messages))
      expect(extractionProgressMessage(processing(stage), [])).toBe(message);
    expect(extractionProgressMessage(processing('LEGACY_INTERNAL_NODE'), [])).toBe(
      '正在分析产品资料',
    );
    expect(extractionProgressMessage(processing(null), [])).toBe('正在分析产品资料');
  });

  it('follows parallel execution changes instead of displaying the last branch heartbeat', () => {
    const state = processing('COMMERCE');
    expect(
      extractionProgressMessage(state, [
        node('DOCUMENT', 'RUNNING'),
        node('IMAGE', 'RUNNING'),
        node('COMMERCE', 'SKIPPED'),
      ]),
    ).toBe('正在解析文档、识别图片');
    expect(
      extractionProgressMessage(state, [
        node('DOCUMENT', 'SUCCEEDED'),
        node('IMAGE', 'RUNNING'),
        node('COMMERCE', 'SKIPPED'),
      ]),
    ).toBe('正在识别图片');
    expect(
      extractionProgressMessage(state, [
        node('DOCUMENT', 'FAILED'),
        node('IMAGE', 'RUNNING'),
        node('COMMERCE', 'RUNNING'),
      ]),
    ).toBe('正在识别图片、读取电商信息');
  });

  it('prefers later stages while persisted branch records and heartbeat catch up', () => {
    const nodes = [node('IMAGE', 'RUNNING'), node('SEMANTIC_REFINEMENT', 'RUNNING')];
    expect(extractionProgressMessage(processing('IMAGE'), nodes)).toBe(
      '正在核对图片补充与已有卖点',
    );
    expect(extractionProgressMessage(processing('NORMALIZATION'), [node('IMAGE', 'RUNNING')])).toBe(
      '正在整理并保存产品信息卡',
    );
  });

  it('uses task status for queued and terminal runs even when node state is stale', () => {
    const nodes = [node('IMAGE', 'RUNNING')];
    for (const [status, message] of [
      ['QUEUED', '正在等待 AI 提炼服务接单'],
      ['COMPLETED', '产品信息提炼已完成'],
      ['FAILED', '本次产品信息提炼失败'],
      ['STALE', '产品资料已变化，等待重新提炼'],
      ['NOT_GENERATED', '尚未开始产品信息提炼'],
    ] as const)
      expect(extractionProgressMessage({ status, currentNode: 'IMAGE' }, nodes)).toBe(message);
    expect(extractionProgressMessage(null, nodes)).toBe('');
  });
});
