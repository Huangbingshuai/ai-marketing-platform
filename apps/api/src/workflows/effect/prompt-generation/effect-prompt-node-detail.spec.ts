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

const v11RunRecord = (): EffectPromptNodeDetailRunRecord => {
  const base = runRecord();
  const creativeDimensions = {
    narrative: '场景代入型',
    scene: '家庭厨房蒸锅旁',
    persona: '准备家宴的成年女性',
    productRelation: '广式腊肠蒸熟后的油润切面',
    camera: '桌面高度中近景缓慢推进',
    emotion: '温暖而有食欲感',
  };
  const creativeItems = Array.from({ length: 4 }, (_, index) => ({
    slotId: `private-v11-slot-${index + 1}`,
    ordinal: index + 1,
    round: 0,
    creativeCore: `家宴上桌前展示广式腊肠切面 ${index + 1}`,
    declaredFactIds: ['PRODUCT_NAME:private-fact-id'],
    dimensions: creativeDimensions,
    content: `蒸锅掀开后，成年女性用木筷夹起第 ${index + 1} 片广式腊肠，油润切面朝向镜头并稳定停留。`,
  }));
  const evaluations = creativeItems.map((item, index) => ({
    slotId: item.slotId,
    primaryPurpose: index === 0 ? 'HOOK' : 'PRODUCT_DISPLAY',
    compatiblePurposes: index === 0 ? ['HOOK', 'PRODUCT_DISPLAY'] : ['PRODUCT_DISPLAY'],
    scores: {
      productRelevance: 90 - index,
      creativeCoherence: 86,
      visualExecutability: 84,
      commercialUsefulness: 82,
      visualClarity: 88,
    },
    hardIssues: index === 3 ? ['SOURCE_FACT_VIOLATION'] : [],
    warnings: index === 2 ? ['VISUAL_OVERLAP'] : [],
  }));
  const resultItems = creativeItems.slice(0, 3).map((item, index) => ({
    id: `result-${index + 1}`,
    code: `P00${index + 1}`,
    origin: 'AI',
    fragmentType: index === 0 ? 'HOOK' : 'PRODUCT_DISPLAY',
    primaryPurpose: index === 0 ? 'HOOK' : 'PRODUCT_DISPLAY',
    compatiblePurposes: index === 0 ? ['HOOK', 'PRODUCT_DISPLAY'] : ['PRODUCT_DISPLAY'],
    classificationStatus: 'VERIFIED',
    productRelevance: 90 - index,
    materialTags: ['广式腊肠', '家宴'],
    targetDurationSeconds: 5,
    dimensions: creativeDimensions,
    content: item.content,
    insightBindings: [
      {
        factId: 'PRODUCT_NAME:private-fact-id',
        field: 'PRODUCT_NAME',
        value: '广式腊肠',
        valueHash: 'a'.repeat(64),
        role: 'PRIMARY',
      },
    ],
    manualEdited: false,
    createdAt: '2026-08-28T01:00:00.000Z',
    updatedAt: '2026-08-28T01:00:00.000Z',
  }));
  const stage = (
    nodeId: string,
    summary: string,
    metadata: Record<string, unknown>,
    status = 'SUCCEEDED',
  ) => ({
    nodeId,
    status,
    summary,
    warnings: [],
    errorMessage: null,
    metadata,
    updatedAt: new Date('2026-08-28T01:00:00.000Z'),
  });
  return {
    ...base,
    status: 'COMPLETED',
    attemptCount: 1,
    inputSnapshot: {
      schemaVersion: 6,
      graphVersion: 'V11_VISUAL_USAGE_STRATEGY',
      settings: { targetCount: 3, defaultDurationSeconds: 5 },
      insightArtifact: {
        result: {
          productName: '广式腊肠',
          productCategory: '中式腊味',
          coreSellingPoints: ['广府糖酒腌制工艺', '蒸熟后油润有光泽'],
          corePainPoints: ['普通腊味口感偏干'],
          targetAudience: '准备家庭聚餐的成年人',
          usageScenarios: ['家庭蒸制', '年夜饭摆盘'],
          disabledElements: ['虚构医疗功效', '未确认价格'],
        },
      },
      retainedManualItems: [],
      sharedPrompt: {
        schemaVersion: 1,
        sections: [
          {
            key: 'USER_ADDITIONAL',
            title: '用户补充',
            source: 'USER',
            content: '保持画面生活化',
            editable: true,
            sourceHash: 'b'.repeat(64),
          },
        ],
        compiledContent: '保持画面生活化',
        contentHash: 'c'.repeat(64),
      },
    },
    stages: [
      stage('LOAD_AND_SNAPSHOT', '输入快照已锁定', {}),
      stage('INSIGHT_MAPPING', '提炼信息用途映射完成', {
        requiredCount: 4,
        adaptiveCount: 2,
        excludedCount: 1,
        appliedConstraintCount: 2,
        requiredFacts: [
          { field: 'PRODUCT_NAME', value: '广式腊肠' },
          { field: 'CORE_SELLING_POINT', value: '广府糖酒腌制工艺' },
        ],
        adaptiveFacts: [{ field: 'USAGE_SCENARIO', value: '年夜饭摆盘' }],
        excludedFacts: [{ field: 'PRICE', value: '价格待确认', reason: 'UNCERTAIN' }],
        appliedConstraints: [{ field: 'DISABLED_ELEMENT', value: '虚构医疗功效' }],
      }),
      stage('SHARED_PROMPT_COMPILATION', '批次共用提示词已编译', {
        disabledElementCount: 2,
        sectionCount: 2,
        sharedPromptGenerated: true,
        hasUserAdditionalContent: true,
        compiledContent: '画面中不得出现虚构医疗功效、未确认价格。\n保持画面生活化。',
        sections: [
          { title: '系统约束', source: 'SYSTEM', content: '画面中不得出现虚构医疗功效。' },
          { title: '用户补充', source: 'USER', content: '保持画面生活化。' },
        ],
      }),
      stage('COHERENT_CREATIVE_GENERATION', '连贯六维创意生成完成', {
        targetCount: 3,
        candidateCount: 4,
        completedShardCount: 1,
      }),
      stage('CREATIVE_EVALUATION_CLASSIFICATION', '创意质量评估与用途分类完成', {
        evaluatedCount: 4,
        acceptedCount: 3,
        rejectedCount: 1,
        completedShardCount: 1,
      }),
      stage('EXACT_SELECTION_AND_SUPPLEMENT', '质量优先筛选完成', {
        acceptedCount: 3,
        targetCount: 3,
        missingCount: 0,
        exactDuplicateCount: 0,
        supplemented: false,
        fixedAnchorCount: 1,
        embeddingInputCount: 4,
        embeddingRequestCount: 1,
        embeddingDurationMs: 120.5,
        localComparisonMs: 0.8,
        mmrQualityWeight: 0.7,
        mmrDiversityWeight: 0.3,
        initialRedundantCandidateCount: 2,
        finalRedundantCandidateCount: 1,
        diversitySupplementTriggered: true,
        diversitySupplementCount: 2,
      }),
      stage('RESULT_SAVE', 'Prompt 批次结果已保存', {
        batchSize: 3,
        qualityStatus: 'PASS',
      }),
    ],
    shards: [
      {
        phase: 'BLUEPRINT',
        round: 0,
        shardIndex: 0,
        status: 'SUCCEEDED',
        combinationPlan: creativeItems.map((item) => ({
          slotId: item.slotId,
          ordinal: item.ordinal,
          round: 0,
          targetDurationSeconds: 5,
          preferredFactIds: item.declaredFactIds,
        })),
        items: creativeItems,
      },
      {
        phase: 'PROMPT',
        round: 0,
        shardIndex: 0,
        status: 'SUCCEEDED',
        combinationPlan: creativeItems.map((item) => item.slotId),
        items: evaluations,
      },
    ],
    result: {
      draftResult: {
        schemaVersion: 6,
        settings: { targetCount: 3, defaultDurationSeconds: 5 },
        sharedPrompt: {
          schemaVersion: 1,
          sections: [],
          compiledContent: '画面中不得出现虚构医疗功效。\n保持画面生活化。',
          contentHash: 'd'.repeat(64),
        },
        items: resultItems,
        metrics: {
          targetCount: 3,
          candidateTargetCount: 4,
          generatedCandidateCount: 4,
          acceptedCount: 3,
          rejectedCount: 1,
          replenishmentRounds: 0,
          exactDuplicateCount: 0,
          purposeDistribution: [
            { purpose: 'HOOK', primaryCount: 1, compatibleCount: 1 },
            { purpose: 'PAIN', primaryCount: 0, compatibleCount: 0 },
            { purpose: 'PRODUCT_DISPLAY', primaryCount: 2, compatibleCount: 3 },
            { purpose: 'SELLING_POINT_EXPLANATION', primaryCount: 0, compatibleCount: 0 },
            { purpose: 'CTA', primaryCount: 0, compatibleCount: 0 },
            { purpose: 'OUTRO', primaryCount: 0, compatibleCount: 0 },
          ],
          averageScores: {
            productRelevance: 89,
            creativeCoherence: 86,
            visualExecutability: 84,
            commercialUsefulness: 82,
            visualClarity: 88,
          },
          hardIssueCounts: [{ code: 'SOURCE_FACT_VIOLATION', count: 1 }],
          warningCounts: [{ code: 'VISUAL_OVERLAP', count: 1 }],
        },
        qualityStatus: 'PASS',
      },
    },
  } as unknown as EffectPromptNodeDetailRunRecord;
};

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

  it.each([
    'LOAD_AND_SNAPSHOT',
    'INSIGHT_MAPPING',
    'SHARED_PROMPT_COMPILATION',
    'COHERENT_CREATIVE_GENERATION',
    'CREATIVE_EVALUATION_CLASSIFICATION',
    'EXACT_SELECTION_AND_SUPPLEMENT',
    'RESULT_SAVE',
  ] as const)('projects explicit V11 input and output sections for %s', (nodeId) => {
    const detail = presentEffectPromptNodeDetail(v11RunRecord(), nodeId);
    expect(detail.sections.map(({ kind }) => kind)).toEqual(['INPUT', 'OUTPUT', 'EXECUTION']);
    expect(detail.sections.find(({ kind }) => kind === 'INPUT')?.title).toBe('本次输入');
    expect(detail.sections.find(({ kind }) => kind === 'OUTPUT')?.state).toBe('ACTUAL');
    expect(JSON.stringify(detail)).not.toMatch(/private-v11-slot|private-fact-id/u);
  });

  it('shows input and safe strategy samples for fact visual strategy compilation', () => {
    const record = v11RunRecord();
    record.inputSnapshot = {
      ...(record.inputSnapshot as Record<string, unknown>),
      graphVersion: 'V11_VISUAL_USAGE_STRATEGY',
    };
    record.stages.splice(2, 0, {
      ...record.stages[0]!,
      nodeId: 'FACT_VISUAL_STRATEGY_COMPILATION',
      status: 'SUCCEEDED',
      summary: '事实视觉使用策略已编译',
      warnings: [],
      errorMessage: null,
      metadata: {
        policyCount: 6,
        usageCounts: {
          DIRECTLY_VISIBLE: 2,
          ACTION_DEMONSTRABLE: 1,
          FORBIDDEN_VISUAL_PROOF: 1,
        },
        reusedCheckpoint: false,
        samples: [
          {
            field: 'VISUAL_FEATURES',
            value: '蒸熟后油润有光泽',
            visualUsage: 'DIRECTLY_VISIBLE',
            visualInstruction: '展示自然油光',
            contextInstruction: '',
            forbiddenInferences: ['不得用光泽证明配方'],
          },
        ],
        checkpoint: { privateFactId: 'must-not-leak' },
      },
      updatedAt: new Date('2026-08-28T01:00:00.000Z'),
    });

    const detail = presentEffectPromptNodeDetail(record, 'FACT_VISUAL_STRATEGY_COMPILATION');
    expect(detail.sections.map(({ kind }) => kind)).toEqual(['INPUT', 'OUTPUT', 'EXECUTION']);
    expect(detail.sections.find(({ kind }) => kind === 'OUTPUT')?.fields).toEqual(
      expect.arrayContaining([
        { label: '已编译事实', value: 6 },
        { label: '可直接呈现', value: 2 },
        { label: '禁止视觉证明', value: 1 },
      ]),
    );
    expect(JSON.stringify(detail)).toContain('蒸熟后油润有光泽');
    expect(JSON.stringify(detail)).not.toContain('must-not-leak');
  });

  it('shows the compiled shared prompt and limits V11 creative samples to three', () => {
    const shared = presentEffectPromptNodeDetail(v11RunRecord(), 'SHARED_PROMPT_COMPILATION');
    const creative = presentEffectPromptNodeDetail(v11RunRecord(), 'COHERENT_CREATIVE_GENERATION');
    const sharedBlock = shared.sections
      .find(({ kind }) => kind === 'OUTPUT')
      ?.blocks.find((block) => block.kind === 'TEXT_CONTENT');
    const creativeBlock = creative.sections
      .find(({ kind }) => kind === 'OUTPUT')
      ?.blocks.find((block) => block.kind === 'CREATIVE_SAMPLE_LIST');
    expect(sharedBlock).toMatchObject({
      kind: 'TEXT_CONTENT',
      content: expect.stringContaining('虚构医疗功效'),
    });
    expect(creativeBlock).toMatchObject({
      kind: 'CREATIVE_SAMPLE_LIST',
      totalCount: 4,
      remainingCount: 1,
    });
    if (creativeBlock?.kind !== 'CREATIVE_SAMPLE_LIST') throw new Error('missing V11 samples');
    expect(creativeBlock.items).toHaveLength(3);
  });

  it('shows safe MMR weights, anchors, timing and diversity supplement results', () => {
    const record = v11RunRecord();
    record.stages = record.stages.map((stage) =>
      stage.nodeId === 'EXACT_SELECTION_AND_SUPPLEMENT'
        ? { ...stage, warnings: ['SEMANTIC_DIVERSITY_SOFT_TARGET_NOT_MET'] }
        : stage,
    );
    const detail = presentEffectPromptNodeDetail(record, 'EXACT_SELECTION_AND_SUPPLEMENT');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');

    expect(output?.fields).toEqual(
      expect.arrayContaining([
        { label: '固定参照 Prompt', value: 1 },
        { label: '向量化正文', value: 4 },
        { label: 'MMR 权重', value: '质量 70% / 多样性 30%' },
        { label: '多样性补充', value: '已补充 2 条候选' },
      ]),
    );
    expect(detail.warnings).toEqual([
      '已按目标数量保存；当前批次仍有少量语义相近内容，可按需人工调整',
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/endpoint|embedding-model|raw-vector/iu);
  });

  it('marks running output as partial and pending output as expected', () => {
    const runningRecord = v11RunRecord();
    runningRecord.stages = runningRecord.stages.map((stage) =>
      stage.nodeId === 'COHERENT_CREATIVE_GENERATION' ? { ...stage, status: 'RUNNING' } : stage,
    );
    const pendingRecord = v11RunRecord();
    pendingRecord.stages = pendingRecord.stages.filter(
      (stage) => stage.nodeId !== 'EXACT_SELECTION_AND_SUPPLEMENT',
    );
    expect(
      presentEffectPromptNodeDetail(runningRecord, 'COHERENT_CREATIVE_GENERATION').sections.find(
        ({ kind }) => kind === 'OUTPUT',
      )?.state,
    ).toBe('PARTIAL');
    expect(
      presentEffectPromptNodeDetail(pendingRecord, 'EXACT_SELECTION_AND_SUPPLEMENT').sections.find(
        ({ kind }) => kind === 'OUTPUT',
      )?.state,
    ).toBe('EXPECTED');
  });

  it('states that result save is a draft instead of a committed working artifact', () => {
    const detail = presentEffectPromptNodeDetail(v11RunRecord(), 'RESULT_SAVE');
    const output = detail.sections.find(({ kind }) => kind === 'OUTPUT');
    expect(output?.summary).toContain('节点草稿');
    expect(output?.summary).toContain('完成校验');
    expect(output?.fields).toContainEqual({
      label: '提交状态',
      value: '已保存为节点草稿，尚未提交工作副本',
    });
  });
});
