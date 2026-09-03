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
              ? {
                  initialCandidateCount: 3,
                  cumulativeCandidateCount: 4,
                  safeCandidateCount: 4,
                  selectedCandidateCount: 2,
                  acceptedCount: 2,
                  targetCount: 2,
                  missingCount: 0,
                  missingRequiredFactCount: 1,
                  poolMissingRequiredFactCount: 0,
                  quantitySupplementTriggered: false,
                  quantitySupplementCount: 0,
                  coverageSupplementTriggered: true,
                  coverageSupplementCount: 1,
                  coverageNeedsReview: true,
                  semanticDuplicateRate: 0,
                }
              : nodeId === 'CREATIVE_EVALUATION_CLASSIFICATION'
                ? {
                    semanticEvaluatedCount: 2,
                    semanticDuplicateGroupCount: 0,
                    semanticDuplicateCount: 0,
                    semanticDuplicateRate: 0,
                  }
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
        stage.nodeId === 'COHERENT_CREATIVE_GENERATION' ? { ...stage, status: 'RUNNING' } : stage,
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

  it('当前结果没有旧版卖点覆盖数据时不展示误导性的 0/0', () => {
    const base = record();
    const current = {
      ...base,
      result: {
        draftResult: {
          schemaVersion: 6,
          settings: { targetCount: 1, defaultDurationSeconds: 5 },
          qualityStatus: 'NEEDS_REVIEW',
          items: [
            {
              code: 'P001',
              fragmentType: 'PRODUCT_DISPLAY',
              targetDurationSeconds: 5,
              materialTags: [],
              content: '餐桌上展示一盘已经蒸熟并切好的广式腊肠。',
              dimensions: {
                narrative: '产品展示',
                scene: '家庭餐桌',
                persona: '成年人',
                productRelation: '广式腊肠外观',
                camera: '近景',
                emotion: '烟火食欲感',
              },
            },
          ],
          metrics: {
            targetCount: 1,
            insightCoverage: {
              required: ['fact-a'],
              covered: [],
              missing: ['fact-a'],
            },
          },
        },
      },
    } as unknown as EffectPromptNodeDetailRunRecord;

    const detail = presentEffectPromptNodeDetail(current, 'RESULT_SAVE');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');
    expect(detail.fields).not.toEqual(
      expect.arrayContaining([{ label: '卖点覆盖', value: '0/0' }]),
    );
    expect(output?.fields).toEqual(
      expect.arrayContaining([
        { label: '必用事实覆盖', value: '0/1' },
        { label: '仍缺事实', value: 1 },
      ]),
    );
  });

  it('在评估节点展示固定相似标准和不阻断提交的重复度参考', () => {
    const detail = presentEffectPromptNodeDetail(record(), 'CREATIVE_EVALUATION_CLASSIFICATION');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');
    expect(output?.fields).toEqual(
      expect.arrayContaining([
        { label: '相似判定标准', value: '82%' },
        { label: '重复度参考', value: '< 15%（仅提醒）' },
        { label: '语义重复度（%）', value: 0 },
      ]),
    );
  });

  it('区分初始候选、择优和两类补充，不把未入选误称为淘汰', () => {
    const detail = presentEffectPromptNodeDetail(record(), 'EXACT_SELECTION_AND_SUPPLEMENT');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');
    expect(output?.fields).toEqual(
      expect.arrayContaining([
        { label: '初始候选', value: 3 },
        { label: '累计候选', value: 4 },
        { label: '无硬问题候选', value: 4 },
        { label: 'AI 择优入选', value: 2 },
        { label: '数量补充', value: '未触发' },
        { label: '事实覆盖补充', value: '已补充 1 条候选' },
        { label: '覆盖结论', value: '仍有事实待人工复核' },
      ]),
    );
  });

  it('多样性补充方向未通过复核时不把计划数量冒充实际候选', () => {
    const base = record();
    const current = {
      ...base,
      stages: base.stages.map((stage) =>
        stage.nodeId === 'EXACT_SELECTION_AND_SUPPLEMENT'
          ? {
              ...stage,
              metadata: {
                ...(stage.metadata as Record<string, unknown>),
                diversitySupplementAttempted: true,
                diversitySupplementTriggered: false,
                diversitySupplementCount: 0,
              },
            }
          : stage,
      ),
    } as unknown as EffectPromptNodeDetailRunRecord;

    const detail = presentEffectPromptNodeDetail(current, 'EXACT_SELECTION_AND_SUPPLEMENT');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');
    expect(output?.fields).toEqual(
      expect.arrayContaining([
        {
          label: '多样性补充',
          value: '已尝试规划新方向，但未通过全批复核，未生成候选',
        },
      ]),
    );
  });

  it('展示创意空间、方向和真实分片进度，不暴露内部规划内容', () => {
    const base = record();
    const running = {
      ...base,
      status: 'RUNNING',
      currentNode: 'COHERENT_CREATIVE_GENERATION',
      stages: base.stages.map((stage) =>
        stage.nodeId === 'COHERENT_CREATIVE_GENERATION'
          ? {
              ...stage,
              status: 'RUNNING',
              summary: '创意方案已完成，正在生成候选 Prompt',
              metadata: {
                perceptionPhase: 'CANDIDATE_GENERATION',
                territoryCount: 6,
                directionCount: 12,
                candidateTargetCount: 70,
                totalShardCount: 18,
                completedShardCount: 7,
                pendingShardCount: 11,
                checkpoint: {
                  plan: {
                    landscape: {
                      territories: [
                        {
                          territoryId: 'FAMILY_SHARING',
                          label: '家庭分享空间',
                          sceneBoundary: '家庭餐桌内完成分享与取食，不切换地点。',
                          differentiationGoal: '突出亲友共享与产品自然入席。',
                          targetSlots: 4,
                          actions: [
                            {
                              actionId: 'SHARE_PLATE',
                              label: '共同夹取分享',
                              boundary: '只表现一次连续分享动作。',
                            },
                          ],
                        },
                      ],
                    },
                    directions: [
                      {
                        directionId: 'direction-01',
                        territoryId: 'FAMILY_SHARING',
                        primaryActionId: 'SHARE_PLATE',
                        creativeDirection: '围绕春节家庭围桌分享腊味形成一条连续动作。',
                        priorityDimensions: ['SCENE', 'EMOTION'],
                      },
                    ],
                  },
                },
              },
            }
          : stage,
      ),
      shards: [
        { phase: 'BLUEPRINT', status: 'SUCCEEDED', items: [] },
        { phase: 'BLUEPRINT', status: 'RUNNING', items: [] },
      ],
    } as unknown as EffectPromptNodeDetailRunRecord;
    const detail = presentEffectPromptNodeDetail(running, 'COHERENT_CREATIVE_GENERATION');
    const fields = detail.sections.flatMap((section) => section.fields);
    expect(fields).toEqual(
      expect.arrayContaining([
        { label: '当前步骤', value: '生成候选 Prompt' },
        { label: '产品创意空间', value: 6 },
        { label: '创意方向', value: 12 },
        { label: '候选目标', value: 70 },
        { label: '实时分片进度', value: '1/18' },
        { label: '实际完成分片', value: 1 },
        { label: '当前处理中分片', value: 1 },
      ]),
    );
    expect(JSON.stringify(detail)).not.toContain('事实 ID');
    expect(JSON.stringify(detail)).not.toContain('模型输入');
    const plan = detail.sections
      .flatMap((section) => section.blocks)
      .find((block) => block.kind === 'CREATIVE_PLAN_LIST');
    expect(plan).toMatchObject({
      territoryCount: 1,
      directionCount: 1,
      items: [
        {
          title: '家庭分享空间',
          actions: ['共同夹取分享'],
          directions: [
            {
              code: '方向 01',
              primaryAction: '共同夹取分享',
              priorityDimensions: ['场景', '情绪基调'],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(plan)).not.toContain('FAMILY_SHARING');
    expect(JSON.stringify(plan)).not.toContain('direction-01');
  });
});
