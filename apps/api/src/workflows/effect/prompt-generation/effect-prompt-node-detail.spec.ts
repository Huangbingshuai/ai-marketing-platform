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
      settings: {
        targetCount: 10,
        defaultDurationSeconds: 5,
        styleMode: 'AI_AUTO',
        styleTone: null,
        deliveryChannel: '抖音',
        disabledElements: ['未成年人', '虚构医疗功效'],
      },
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
  it('在评分节点展示诊断驱动的整段修订进度', () => {
    const run = record();
    const stage = run.stages.find((s) => s.nodeId === 'CREATIVE_EVALUATION_CLASSIFICATION')!;
    stage.status = 'RUNNING';
    stage.metadata = {
      perceptionPhase: 'DIAGNOSED_EXECUTION_REWRITE',
      executionRepairAttemptedCount: 3,
      executionAuditCandidateCount: 6,
      executionRepairAcceptedCount: 2,
      executionRepairUnresolvedCount: 1,
    };
    const detail = presentEffectPromptNodeDetail(run, 'CREATIVE_EVALUATION_CLASSIFICATION');
    expect(detail.fields).toContainEqual({ label: '执行修订尝试', value: 3 });
    expect(detail.fields).toContainEqual({ label: '专职执行审片条次', value: 6 });
    expect(detail.fields).toContainEqual({ label: '复评后采用修订', value: 2 });
    expect(detail.fields).toContainEqual({ label: '未修复并移出候选', value: 1 });
    expect(JSON.stringify(detail)).toContain('修订有明确执行问题的素材并复评');
  });

  it('projects unified selling points and counts all facts rather than preview samples', () => {
    const run = record();
    (run.inputSnapshot as Record<string, unknown>).insightArtifact = {
      result: {
        productName: '旅行箱',
        productCategory: '箱包',
        coreSpecification: '20英寸',
        priceRange: '399元',
        visualFeatures: '蓝色箱体',
        sellingPoints: Array.from({ length: 100 }, (_, i) => `独立卖点${i}`),
      },
    };
    const mapping = JSON.stringify(presentEffectPromptNodeDetail(run, 'INSIGHT_MAPPING'));
    expect(mapping).toContain('卖点');
    expect(mapping).toContain('独立卖点0');
    expect(mapping).not.toContain('核心痛点');
    const strategy = presentEffectPromptNodeDetail(run, 'FACT_VISUAL_STRATEGY_COMPILATION');
    expect(strategy.sections?.flatMap((section) => section.fields)).toContainEqual({
      label: '可用事实',
      value: 105,
    });
  });

  it('distinguishes received/planned/background counts without claiming final realization', () => {
    const run = record();
    const stage = run.stages.find((row) => row.nodeId === 'COHERENT_CREATIVE_GENERATION')!;
    stage.metadata = {
      availableSellingPointCount: 100,
      plannedSellingPointCount: 60,
      unplannedSellingPointCount: 40,
      contextSellingPointCount: 20,
    };
    const detail = presentEffectPromptNodeDetail(run, 'COHERENT_CREATIVE_GENERATION');
    const fields = detail.sections?.flatMap((section) => section.fields);
    expect(fields).toContainEqual({ label: '已接收卖点', value: 100 });
    expect(fields).toContainEqual({ label: '已用于创意规划', value: 60 });
    expect(fields?.some((f) => f.label === '最终素材已体现卖点')).toBe(false);
  });
  it('projects three safe material tasks without exposing checkpoint identifiers', () => {
    const run = record();
    const stage = run.stages.find((row) => row.nodeId === 'COHERENT_CREATIVE_GENERATION')!;
    stage.metadata = {
      perceptionPhase: 'MATERIAL_TASK_PLANNING',
      materialTaskCount: 50,
      referenceImageCount: 3,
      checkpoint: {
        sourceFingerprint: 'private-fingerprint',
        plan: {
          rounds: [
            {
              round: 0,
              tasks: Array.from({ length: 50 }, (_, i) => ({
                taskId: `private-task-${i}`,
                factIds: ['private-fact'],
                visualEvent: `真实素材事件${i + 1}`,
                difference: '不同观看价值',
              })),
            },
          ],
        },
      },
    };
    const detail = presentEffectPromptNodeDetail(run, 'COHERENT_CREATIVE_GENERATION');
    const output = detail.sections?.find((section) => section.kind === 'OUTPUT');
    const tasks = output?.blocks.filter((block) => block.title.startsWith('素材任务 '));
    expect(tasks).toHaveLength(3);
    expect(JSON.stringify(output)).toContain('共 50 条，其余 47 条未展开');
    expect(JSON.stringify(detail)).not.toContain('private-');
    expect(JSON.stringify(detail)).not.toContain('CREATIVE_PLAN_LIST');
  });
  it.each(['RUNNING', 'FAILED', 'SUCCEEDED'])(
    '%s 时实时分片覆盖旧阶段计数，所有详情区域保持一致',
    (status) => {
      const base = record();
      const run = {
        ...base,
        stages: base.stages.map((stage) =>
          stage.nodeId === 'COHERENT_CREATIVE_GENERATION'
            ? {
                ...stage,
                status,
                metadata: {
                  generatedCandidateCount: 0,
                  candidateCount: 0,
                  completedShardCount: 0,
                  pendingShardCount: 10,
                  totalShardCount: 1,
                },
              }
            : stage,
        ),
        shards: [
          {
            phase: 'BLUEPRINT',
            status: 'SUCCEEDED',
            combinationPlan: [
              { slotId: 'private-slot', preferredFactIds: [], targetDurationSeconds: 15 },
            ],
            items: [
              {
                slotId: 'private-slot',
                ordinal: 1,
                round: 0,
                creativeCore: '完成一次产品操作',
                content: '使用者将产品放回桌面。',
                declaredFactIds: [],
                dimensions: {
                  narrative: '操作展示',
                  scene: '家中',
                  persona: '成人',
                  productRelation: '日常使用',
                  camera: '固定近景',
                  emotion: '自然',
                },
              },
            ],
          },
          { phase: 'BLUEPRINT', status: 'RUNNING', items: [], combinationPlan: [] },
          { phase: 'BLUEPRINT', status: 'FAILED', items: [], combinationPlan: [] },
          { phase: 'PROMPT', status: 'SUCCEEDED', items: [], combinationPlan: [] },
        ],
      } as unknown as EffectPromptNodeDetailRunRecord;
      const detail = presentEffectPromptNodeDetail(run, 'COHERENT_CREATIVE_GENERATION');
      expect(detail.fields).toEqual(
        expect.arrayContaining([
          { label: '当前候选', value: 1 },
          { label: '已生成候选', value: 1 },
          { label: '已完成分片（含恢复）', value: 1 },
          { label: '本轮待生成分片', value: 1 },
        ]),
      );
      const output = detail.sections.find((s) => s.kind === 'OUTPUT')!;
      expect(output.fields).toEqual(
        expect.arrayContaining([
          { label: '实际生成候选', value: 1 },
          { label: '实时分片进度', value: '1/3' },
        ]),
      );
      expect(detail.sections.find((s) => s.kind === 'EXECUTION')!.fields).toEqual(
        expect.arrayContaining([
          { label: '完成分片', value: 1 },
          { label: '待处理分片', value: 1 },
        ]),
      );
      expect(
        run.stages.find((s) => s.nodeId === 'COHERENT_CREATIVE_GENERATION')!.metadata,
      ).toMatchObject({ generatedCandidateCount: 0, completedShardCount: 0 });
    },
  );

  it.each(['ACCEPTED', 'STARTED', 'KEPT_ORIGINAL', 'WRONG_SLOT'])(
    '修复检查点 %s 的样例与评分一致且不泄露内部字段',
    (status) => {
      const original = {
        slotId: 'private-slot',
        ordinal: 1,
        round: 0,
        creativeCore: '使用者完成一次产品操作',
        declaredFactIds: [],
        dimensions: {
          narrative: '动作展示',
          scene: '日常环境',
          persona: '成年使用者',
          productRelation: '产品参与使用',
          camera: '近景',
          emotion: '自然',
        },
        content: '原稿正文：主体完成一次连续操作，镜头记录完整过程。',
      };
      const corrected = {
        ...original,
        content: '修复正文：使用者施力推动主体，固定机位记录连续操作。',
        slotId: status === 'WRONG_SLOT' ? 'another-private-slot' : original.slotId,
      };
      const run = {
        ...record(),
        shards: [
          {
            phase: 'CREATIVE',
            status: 'SUCCEEDED',
            items: [original],
            combinationPlan: [
              { slotId: original.slotId, preferredFactIds: [], targetDurationSeconds: 5 },
            ],
          },
          {
            phase: 'CLASSIFICATION',
            status: 'SUCCEEDED',
            combinationPlan: [],
            items: [
              {
                slotId: original.slotId,
                primaryPurpose: 'PRODUCT_DISPLAY',
                compatiblePurposes: [],
                scores: {
                  productRelevance: 90,
                  creativeCoherence: 90,
                  visualExecutability: 90,
                  commercialUsefulness: 90,
                  visualClarity: 90,
                },
                hardIssues: [],
                warnings: [],
                executionRepair: {
                  status: status === 'WRONG_SLOT' ? 'ACCEPTED' : status,
                  originalHash: 'private-hash',
                  candidate: corrected,
                },
                executionFindings: [{ diagnosis: 'private-diagnosis' }],
              },
            ],
          },
        ],
      } as unknown as EffectPromptNodeDetailRunRecord;
      const serialized = JSON.stringify(
        presentEffectPromptNodeDetail(run, 'CREATIVE_EVALUATION_CLASSIFICATION'),
      );
      expect(serialized).toContain(status === 'ACCEPTED' ? '修复正文' : '原稿正文');
      expect(serialized).not.toContain(status === 'ACCEPTED' ? '原稿正文' : '修复正文');
      expect(serialized).not.toContain('private-');
      expect(serialized).not.toContain('executionRepair');
    },
  );

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
    } as unknown as EffectPromptNodeDetailRunRecord;
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

  it('在共用提示词节点展示批次设置与最终编译正文', () => {
    const detail = presentEffectPromptNodeDetail(record(), 'SHARED_PROMPT_COMPILATION');
    const input = detail.sections.find(({ kind }) => kind === 'INPUT');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');
    expect(input?.fields).toContainEqual({ label: '禁用元素', value: 2 });
    expect(input?.blocks).toContainEqual({
      kind: 'TAG_LIST',
      title: '批次禁用元素',
      groups: [
        {
          label: '禁用元素',
          values: ['未成年人', '虚构医疗功效'],
          remainingCount: 0,
        },
      ],
    });
    expect(output?.blocks).toContainEqual({
      kind: 'TEXT_CONTENT',
      title: '最终共用提示词',
      content: '画面中不得出现虚构医疗功效。',
      sourceLabels: [],
    });
    expect(output?.fields).toContainEqual({
      label: '使用方式',
      value: '生成时约束创意，视频渲染时统一追加一次',
      description: '不会写进每条 Prompt 正文',
    });
  });

  it('单条 AI 自动补齐展示处理状态', () => {
    const base = record();
    const itemEvaluation = {
      ...base,
      currentNode: 'ITEM_EVALUATE',
      stages: [
        {
          nodeId: 'ITEM_EVALUATE',
          status: 'SUCCEEDED',
          summary: '创意主线与六维信息自动补齐完成',
          warnings: [],
          errorMessage: null,
          metadata: { evaluatedCount: 1, classificationStatus: 'VERIFIED' },
          updatedAt: new Date('2026-08-31T01:00:00.000Z'),
        },
      ],
    } as unknown as EffectPromptNodeDetailRunRecord;

    const detail = presentEffectPromptNodeDetail(itemEvaluation, 'ITEM_EVALUATE');
    expect(detail.fields).toContainEqual({
      label: '自动补齐状态',
      value: 'VERIFIED',
    });
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

  it.each([
    ['CREATIVE_DIRECTION_REVIEW', false, '待通过'],
    ['CANDIDATE_GENERATION', false, '已复核，仍有优化提醒'],
    ['CANDIDATE_GENERATION_COMPLETE', false, '已复核，仍有优化提醒'],
    ['CANDIDATE_GENERATION_COMPLETE', true, '已通过'],
  ])('如实展示规划复核状态：%s / %s', (perceptionPhase, semanticReviewPassed, expected) => {
    const base = record();
    const current = {
      ...base,
      stages: base.stages.map((stage) =>
        stage.nodeId === 'COHERENT_CREATIVE_GENERATION'
          ? { ...stage, metadata: { perceptionPhase, semanticReviewPassed } }
          : stage,
      ),
    } as unknown as EffectPromptNodeDetailRunRecord;
    const detail = presentEffectPromptNodeDetail(current, 'COHERENT_CREATIVE_GENERATION');
    expect(detail.sections.flatMap((section) => section.fields)).toContainEqual({
      label: '规划复核',
      value: expected,
    });
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
                    reviewProgress: {
                      requestFingerprint: 'PRIVATE_REVIEW_FINGERPRINT',
                      completedBatches: { privateBatch: { summary: 'PRIVATE_REVIEW_BODY' } },
                    },
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
        { label: '已完成分片（含恢复）', value: 1 },
        { label: '实时分片进度', value: '1/18' },
        { label: '实际完成分片', value: 1 },
        { label: '当前处理中分片', value: 1 },
      ]),
    );
    expect(JSON.stringify(detail)).not.toContain('事实 ID');
    expect(JSON.stringify(detail)).not.toContain('开始前已恢复分片');
    expect(JSON.stringify(detail)).not.toContain('模型输入');
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_REVIEW');
    expect(JSON.stringify(detail)).not.toContain('completedBatches');
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
