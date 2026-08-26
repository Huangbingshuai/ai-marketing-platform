import type {
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptNodeDetailBlock,
  EffectPromptNodeDetailField,
  EffectPromptNodeDetailPrompt,
  EffectPromptNodeId,
  GetEffectPromptNodeDetailData,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_NODE_DETAIL_LIMITS,
} from '@ai-marketing/contracts';

import type { EffectPromptNodeDetailRunRecord } from './effect-prompt.repository';
import {
  EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD,
  EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD,
  isEffectPromptSettings,
  trigramDice,
} from './effect-prompt.quality';

type JsonRecord = Record<string, unknown>;
type Candidate = EffectPromptNodeDetailPrompt & {
  invalidReasons: string[];
  ordinal: number;
  round: number;
  shardIndex: number;
};
type Combination = {
  dimensions: EffectPromptDimensions;
  evidenceMode: string;
  fragmentType: EffectPromptFragmentType;
  ordinal: number;
  round: number;
  shardIndex: number;
  targetDurationSeconds: number;
  visibleAction: string;
};
type DisplayResult = {
  items: EffectPromptNodeDetailPrompt[];
  qualityStatus: string;
  metrics: {
    acceptedCount: number;
    executionInvalidReasons: Array<{ code: string; count: number }>;
    fragmentTypeDistribution: Array<{
      actualCount: number;
      fragmentType: EffectPromptFragmentType;
      targetCount: number;
    }>;
    insightCoverage: JsonRecord;
    removedDimensionConflicts: number;
    removedExecutionInvalid: number;
    removedSemanticDuplicates: number;
    removedVisualDuplicates: number;
    semanticDuplicateRate: number;
    sellingPointCoverage: { covered: string[]; missing: string[]; required: string[] };
    targetCount: number;
    visualOverlapRate: number;
  };
};

const GENERATION_FRAGMENT_BY_NODE: Partial<Record<EffectPromptNodeId, EffectPromptFragmentType>> = {
  GENERATE_HOOK: 'HOOK',
  GENERATE_PAIN: 'PAIN',
  GENERATE_PRODUCT_DISPLAY: 'PRODUCT_DISPLAY',
  GENERATE_SELLING_POINT_EXPLANATION: 'SELLING_POINT_EXPLANATION',
  GENERATE_CTA: 'CTA',
  GENERATE_OUTRO: 'OUTRO',
};

const ISSUE_LABELS: Record<string, string> = {
  ABSTRACT_VISUAL: '把抽象信息伪造成可见画面证据',
  ABSTRACT_PERSONA: '受众画像被当作出镜人物',
  AUDIO_OVERREACH: '素材包含口播、旁白或背景音乐要求',
  BAKED_TEXT: '素材要求烧录字幕或界面文字',
  BROKEN_TEXT: '正文存在破损或占位内容',
  DIMENSION_CONFLICT: '六维差异不足',
  DURATION_MISMATCH: '片段时长与类型配置不一致',
  FIELD_DUPLICATION: '字段或句子机械重复',
  FULL_TIMELINE: '包含完整时间轴或多镜头结构',
  FULL_TIMELINE_NOT_FRAGMENT: '包含完整时间轴或多镜头结构',
  CAMERA_CONFLICT: '同一片段包含互相冲突的运镜',
  FACT_OVERLOAD: '单条片段承载了过多提炼事实',
  META_LANGUAGE: '包含策划元话语',
  MULTI_STAGE_STORY: '片段包含多个叙事阶段',
  NO_VISIBLE_ACTION: '缺少可拍摄的连续动作',
  NEGATIVE_TAIL_DUPLICATION: '重复附加了长篇禁用说明',
  OVERLOADED_ACTION: '单条片段包含多个主要动作',
  PLACEHOLDER_TEXT: '正文存在占位描述',
  ROLE_CONFLICT: '片段承担了互相冲突的职责',
  PHYSICS_BREAK: '画面包含缺乏依据的物理跳变',
  REFERENCE_DEPENDENCY: '没有参考图却要求精确还原包装细节',
  SEMANTIC_DUPLICATE: '语义高度相似',
  SOURCE_FACT_VIOLATION: '使用了上游未确认事实',
  STACKED_PERSONA: '人物身份或受众画像堆叠',
  UNFILMABLE_EVIDENCE: '把不可观察信息写成确定画面',
  VISUAL_OVERLAP: '画面结构高度重合',
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const publicText = (value: unknown, maxLength = 12_000): string =>
  String(value ?? '')
    .replace(/data:[^\s,]+;base64,[a-z\d+/=]+/giu, '[图片数据已隐藏]')
    .replace(/[a-z\d+/]{256,}={0,2}/giu, '[Base64 数据已隐藏]')
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '[链接已隐藏]')
    .replace(/[a-z]:\\(?:[^\\\s]+\\)+[^\s]+/giu, '[本地路径已隐藏]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);

const safeStrings = (value: unknown, limit = 40): string[] =>
  (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string')
    .map((item) => publicText(item, 400))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .slice(0, limit);

const safeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const fragmentType = (value: unknown): EffectPromptFragmentType | null =>
  typeof value === 'string' &&
  EFFECT_PROMPT_FRAGMENT_TYPES.includes(value as EffectPromptFragmentType)
    ? (value as EffectPromptFragmentType)
    : null;

const dimensions = (value: unknown): EffectPromptDimensions | null => {
  if (!isRecord(value)) return null;
  const entries = EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, publicText(value[key], 240)]);
  if (entries.some(([, item]) => !item)) return null;
  return Object.fromEntries(entries) as EffectPromptDimensions;
};

const metadataRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

const compact = (
  fields: Array<EffectPromptNodeDetailField | null>,
): EffectPromptNodeDetailField[] =>
  fields.filter((field): field is EffectPromptNodeDetailField => field !== null);

const textField = (label: string, value: unknown): EffectPromptNodeDetailField | null => {
  const text = publicText(value, 1000);
  return text ? { label, value: text } : null;
};

const numberField = (
  metadata: JsonRecord,
  key: string,
  label: string,
): EffectPromptNodeDetailField | null => {
  const value = safeNumber(metadata[key]);
  return value === null ? null : { label, value };
};

const enumField = (
  metadata: JsonRecord,
  key: string,
  label: string,
  allowed: readonly string[],
): EffectPromptNodeDetailField | null => {
  const value = metadata[key];
  return typeof value === 'string' && allowed.includes(value) ? { label, value } : null;
};

const inputSnapshot = (run: EffectPromptNodeDetailRunRecord): JsonRecord =>
  metadataRecord(run.inputSnapshot);

const inputSettings = (run: EffectPromptNodeDetailRunRecord): EffectPromptBatchSettings | null => {
  const settings = inputSnapshot(run).settings;
  return isEffectPromptSettings(settings) ? settings : null;
};

const insightResult = (run: EffectPromptNodeDetailRunRecord): JsonRecord => {
  const artifact = metadataRecord(inputSnapshot(run).insightArtifact);
  return metadataRecord(artifact.result);
};

const insightText = (insight: JsonRecord, ...keys: string[]): string => {
  for (const key of keys) {
    const value = publicText(insight[key], 500);
    if (value) return value;
  }
  return '';
};

const insightList = (insight: JsonRecord, ...keys: string[]): string[] => {
  for (const key of keys) {
    const value = safeStrings(insight[key]);
    if (value.length) return value;
  }
  return [];
};

const insightReferenceValues = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).flatMap((item) => {
    if (!isRecord(item)) return [];
    const text = publicText(item.value, 400);
    return text ? [text] : [];
  });

const promptCode = (ordinal: number): string => `P${String(ordinal).padStart(3, '0')}`;

const candidates = (run: EffectPromptNodeDetailRunRecord): Candidate[] => {
  const rows: Candidate[] = [];
  for (const shard of run.shards) {
    for (const raw of Array.isArray(shard.items) ? shard.items : []) {
      if (!isRecord(raw)) continue;
      const type = fragmentType(raw.fragmentType);
      const itemDimensions = dimensions(raw.dimensions);
      const content = publicText(raw.content);
      const ordinal = safeNumber(raw.ordinal);
      const duration = safeNumber(raw.targetDurationSeconds);
      if (!type || !itemDimensions || !content || ordinal === null || duration === null) continue;
      rows.push({
        code: promptCode(ordinal),
        fragmentType: type,
        materialTags: safeStrings(raw.materialTags, 12),
        targetDurationSeconds: duration,
        dimensions: itemDimensions,
        content,
        invalidReasons: safeStrings(raw.executionInvalidReasons, 20),
        ordinal,
        round: shard.round,
        shardIndex: shard.shardIndex,
      });
    }
  }
  return rows
    .filter(
      (item, index, items) =>
        items.findIndex(
          (candidate) => candidate.ordinal === item.ordinal && candidate.content === item.content,
        ) === index,
    )
    .sort((left, right) => left.ordinal - right.ordinal || left.round - right.round);
};

const combinations = (run: EffectPromptNodeDetailRunRecord): Combination[] => {
  const rows: Combination[] = [];
  for (const shard of run.shards) {
    for (const raw of Array.isArray(shard.combinationPlan) ? shard.combinationPlan : []) {
      if (!isRecord(raw)) continue;
      const type = fragmentType(raw.fragmentType);
      const itemDimensions = dimensions(raw.dimensions);
      const ordinal = safeNumber(raw.ordinal);
      const duration = safeNumber(raw.targetDurationSeconds);
      if (!type || !itemDimensions || ordinal === null || duration === null) continue;
      rows.push({
        fragmentType: type,
        dimensions: itemDimensions,
        evidenceMode: publicText(raw.evidenceMode, 80),
        visibleAction: publicText(raw.visibleAction, 500),
        targetDurationSeconds: duration,
        ordinal,
        round: shard.round,
        shardIndex: shard.shardIndex,
      });
    }
  }
  return rows
    .filter(
      (item, index, items) =>
        items.findIndex(
          (candidate) => candidate.ordinal === item.ordinal && candidate.round === item.round,
        ) === index,
    )
    .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal);
};

const promptPreview = (item: EffectPromptNodeDetailPrompt): EffectPromptNodeDetailPrompt => ({
  code: publicText(item.code, 40),
  fragmentType: item.fragmentType,
  materialTags: safeStrings(item.materialTags, 12),
  targetDurationSeconds: item.targetDurationSeconds,
  dimensions: Object.fromEntries(
    EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, publicText(item.dimensions[key], 240)]),
  ) as EffectPromptDimensions,
  content: publicText(item.content),
});

const rawPromptPreview = (value: unknown): EffectPromptNodeDetailPrompt | null => {
  if (!isRecord(value)) return null;
  const type = fragmentType(value.fragmentType);
  const itemDimensions = dimensions(value.dimensions);
  const content = publicText(value.content);
  const duration = safeNumber(value.targetDurationSeconds);
  const code = publicText(value.code, 40);
  if (!type || !itemDimensions || !content || duration === null || !code) return null;
  return {
    code,
    fragmentType: type,
    materialTags: safeStrings(value.materialTags, 12),
    targetDurationSeconds: duration,
    dimensions: itemDimensions,
    content,
  };
};

const retainedPrompts = (run: EffectPromptNodeDetailRunRecord): EffectPromptNodeDetailPrompt[] => {
  const retained = inputSnapshot(run).retainedManualItems;
  return (Array.isArray(retained) ? retained : []).flatMap((item) => {
    const parsed = rawPromptPreview(item);
    return parsed ? [parsed] : [];
  });
};

const finalResult = (run: EffectPromptNodeDetailRunRecord): DisplayResult | null => {
  const raw = run.result ? metadataRecord(run.result.draftResult) : {};
  const metrics = metadataRecord(raw.metrics);
  const coverage = metadataRecord(metrics.sellingPointCoverage);
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((item) => {
    const parsed = rawPromptPreview(item);
    return parsed ? [parsed] : [];
  });
  if (!items.length) return null;
  const distribution = (
    Array.isArray(metrics.fragmentTypeDistribution) ? metrics.fragmentTypeDistribution : []
  ).flatMap((item) => {
    if (!isRecord(item)) return [];
    const type = fragmentType(item.fragmentType);
    const targetCount = safeNumber(item.targetCount);
    const actualCount = safeNumber(item.actualCount);
    return type && targetCount !== null && actualCount !== null
      ? [{ fragmentType: type, targetCount, actualCount }]
      : [];
  });
  const reasons = (
    Array.isArray(metrics.executionInvalidReasons) ? metrics.executionInvalidReasons : []
  ).flatMap((item) => {
    if (!isRecord(item)) return [];
    const code = publicText(item.code, 120);
    const count = safeNumber(item.count);
    return code && count !== null ? [{ code, count }] : [];
  });
  const metricNumber = (key: string): number => safeNumber(metrics[key]) ?? 0;
  return {
    items,
    qualityStatus: publicText(raw.qualityStatus, 40) || 'NEEDS_REVIEW',
    metrics: {
      acceptedCount: metricNumber('acceptedCount'),
      targetCount: metricNumber('targetCount'),
      removedSemanticDuplicates: metricNumber('removedSemanticDuplicates'),
      removedVisualDuplicates: metricNumber('removedVisualDuplicates'),
      removedDimensionConflicts: metricNumber('removedDimensionConflicts'),
      removedExecutionInvalid: metricNumber('removedExecutionInvalid'),
      semanticDuplicateRate: metricNumber('semanticDuplicateRate'),
      visualOverlapRate: metricNumber('visualOverlapRate'),
      fragmentTypeDistribution: distribution,
      sellingPointCoverage: {
        required: safeStrings(coverage.required),
        covered: safeStrings(coverage.covered),
        missing: safeStrings(coverage.missing),
      },
      insightCoverage: metadataRecord(metrics.insightCoverage),
      executionInvalidReasons: reasons,
    },
  };
};

const tagGroup = (label: string, values: string[]) => {
  const unique = values
    .filter(Boolean)
    .filter((value, index, items) => items.indexOf(value) === index);
  return {
    label,
    values: unique.slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxTagValues),
    remainingCount: Math.max(0, unique.length - EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxTagValues),
  };
};

const tagBlock = (
  title: string,
  groups: Array<ReturnType<typeof tagGroup>>,
): EffectPromptNodeDetailBlock | null => {
  const visible = groups.filter(({ values }) => values.length);
  return visible.length ? { kind: 'TAG_LIST', title, groups: visible } : null;
};

const combinationBlock = (
  title: string,
  items: Combination[],
): EffectPromptNodeDetailBlock | null => {
  const visible = items.slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples);
  return visible.length
    ? {
        kind: 'COMBINATION_LIST',
        title,
        items: visible.map((item, index) => ({
          title: `组合 ${index + 1} · ${EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.fragmentType]}`,
          fragmentType: item.fragmentType,
          targetDurationSeconds: item.targetDurationSeconds,
          dimensions: item.dimensions,
          visibleAction: item.visibleAction,
          evidenceMode: item.evidenceMode,
        })),
      }
    : null;
};

const promptBlock = (
  title: string,
  items: EffectPromptNodeDetailPrompt[],
): EffectPromptNodeDetailBlock | null => {
  const visible = items.slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples).map(promptPreview);
  return visible.length ? { kind: 'PROMPT_LIST', title, items: visible } : null;
};

const routeBlock = (
  run: EffectPromptNodeDetailRunRecord,
  title: string,
  finalCounts?: Partial<Record<EffectPromptFragmentType, number>>,
): EffectPromptNodeDetailBlock | null => {
  const settings = inputSettings(run);
  if (!settings) return null;
  const allCandidates = candidates(run);
  const rows = EFFECT_PROMPT_FRAGMENT_TYPES.map((type) => {
    const typeShards = run.shards.filter((shard) =>
      (Array.isArray(shard.combinationPlan) ? shard.combinationPlan : []).some(
        (raw) => isRecord(raw) && raw.fragmentType === type,
      ),
    );
    const completedShards = typeShards.filter(({ status }) => status === 'SUCCEEDED').length;
    const failedShards = typeShards.filter(({ status }) => status === 'FAILED').length;
    const runningShards = typeShards.filter(({ status }) => status === 'RUNNING').length;
    const status = failedShards
      ? completedShards
        ? 'PARTIAL'
        : 'FAILED'
      : runningShards
        ? 'RUNNING'
        : completedShards
          ? 'SUCCEEDED'
          : 'PENDING';
    return {
      fragmentType: type,
      targetCount: settings.fragmentConfigs[type].count,
      candidateCount:
        finalCounts?.[type] ?? allCandidates.filter((item) => item.fragmentType === type).length,
      totalShards: typeShards.length,
      completedShards,
      failedShards,
      status,
    } as const;
  });
  return { kind: 'ROUTE_LIST', title, items: rows };
};

const issueBlock = (
  title: string,
  issues: Array<{ code: string; count: number; examples?: string[] }>,
): EffectPromptNodeDetailBlock | null => {
  const visible = issues
    .filter(({ count }) => count > 0)
    .slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxIssues)
    .map(({ code, count, examples = [] }) => ({
      code: publicText(code, 120),
      label: ISSUE_LABELS[code] ?? publicText(code, 160),
      count,
      examples: examples
        .map((example) => publicText(example, 500))
        .filter(Boolean)
        .slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples),
    }));
  return visible.length ? { kind: 'ISSUE_LIST', title, items: visible } : null;
};

const normalizedValue = (value: string): string =>
  value.normalize('NFC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ');

const semanticSignature = (item: EffectPromptNodeDetailPrompt): string =>
  [
    item.fragmentType,
    item.dimensions.narrative,
    item.dimensions.sellingPoint,
    item.dimensions.scene,
  ]
    .map(normalizedValue)
    .join('|');

const pairBlock = (
  title: string,
  metric: 'SEMANTIC' | 'VISUAL',
  items: EffectPromptNodeDetailPrompt[],
): EffectPromptNodeDetailBlock | null => {
  const pairs: Extract<EffectPromptNodeDetailBlock, { kind: 'PAIR_LIST' }>['items'] = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex]!;
      const right = items[rightIndex]!;
      if (metric === 'SEMANTIC') {
        const sameSignature = semanticSignature(left) === semanticSignature(right);
        const score = sameSignature ? 1 : trigramDice(left.content, right.content);
        if (score < EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD) continue;
        pairs.push({
          score,
          reasons: [sameSignature ? '结构化内容意图一致' : '正文语义高度相似'],
          left: promptPreview(left),
          right: promptPreview(right),
        });
        continue;
      }
      const visualKeys = [
        ['scene', '场景'],
        ['persona', '人物'],
        ['camera', '镜头'],
        ['emotion', '情绪'],
      ] as const;
      const visualWeights = { scene: 0.35, persona: 0.2, camera: 0.3, emotion: 0.15 } as const;
      const score = visualKeys.reduce(
        (total, [key]) =>
          total +
          (normalizedValue(left.dimensions[key]) === normalizedValue(right.dimensions[key])
            ? visualWeights[key]
            : 0),
        0,
      );
      if (score < EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD) continue;
      const reasons = visualKeys.flatMap(([key, label]) =>
        normalizedValue(left.dimensions[key as keyof EffectPromptDimensions]) ===
        normalizedValue(right.dimensions[key as keyof EffectPromptDimensions])
          ? [label]
          : [],
      );
      pairs.push({
        score,
        reasons,
        left: promptPreview(left),
        right: promptPreview(right),
      });
    }
  }
  const visible = pairs
    .sort((left, right) => right.score - left.score)
    .slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples)
    .map((pair) => ({ ...pair, score: Math.round(pair.score * 10_000) / 10_000 }));
  return visible.length ? { kind: 'PAIR_LIST', title, metric, items: visible } : null;
};

const nodeMetricFields = (
  nodeId: EffectPromptNodeId,
  rawMetadata: unknown,
): EffectPromptNodeDetailField[] => {
  const metadata = metadataRecord(rawMetadata);
  switch (nodeId) {
    case 'INSIGHT_MAPPING':
      return compact([
        numberField(metadata, 'requiredCount', '必须应用信息'),
        numberField(metadata, 'adaptiveCount', '自适应信息'),
        numberField(metadata, 'excludedCount', '不适用信息'),
      ]);
    case 'STRATEGY_PLANNING':
      return compact([
        numberField(metadata, 'narrativeCount', '叙事方案'),
        numberField(metadata, 'sceneCount', '场景方案'),
        numberField(metadata, 'personaCount', '人物方案'),
        numberField(metadata, 'sellingPointCount', '卖点方案'),
        numberField(metadata, 'cameraCount', '镜头方案'),
        numberField(metadata, 'emotionCount', '情绪方案'),
        numberField(metadata, 'actionCount', '动作方案'),
        numberField(metadata, 'evidencePlanCount', '证据方案'),
      ]);
    case 'DIMENSION_COMBINATION':
      return compact([
        numberField(metadata, 'plannedCandidateCount', '计划候选数'),
        numberField(metadata, 'pendingShardCount', '待生成分片'),
        numberField(metadata, 'resumedShardCount', '恢复分片'),
        numberField(metadata, 'replenishmentRound', '规划轮次'),
      ]);
    case 'FRAGMENT_TYPE_ROUTER':
      return compact([
        numberField(metadata, 'fragmentTypeCount', '路由类型'),
        numberField(metadata, 'totalShards', '分片总数'),
        numberField(metadata, 'routedShards', '已路由分片'),
      ]);
    case 'GENERATE_HOOK':
    case 'GENERATE_PAIN':
    case 'GENERATE_PRODUCT_DISPLAY':
    case 'GENERATE_SELLING_POINT_EXPLANATION':
    case 'GENERATE_CTA':
    case 'GENERATE_OUTRO':
      return compact([
        numberField(metadata, 'targetCount', '目标数量'),
        numberField(metadata, 'candidateCount', '候选数量'),
        numberField(metadata, 'totalShards', '分片总数'),
        numberField(metadata, 'completedShards', '完成分片'),
      ]);
    case 'NORMALIZATION':
      return compact([numberField(metadata, 'candidateCount', '可执行 Prompt')]);
    case 'SEMANTIC_DEDUP':
      return compact([
        numberField(metadata, 'comparedPairCount', '比较 Prompt 对'),
        numberField(metadata, 'violatingPairCount', '语义相似对'),
        numberField(metadata, 'semanticDuplicateRate', '语义重复度（%）'),
        { label: '相似判定阈值', value: EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD },
      ]);
    case 'VISUAL_DEDUP':
      return compact([
        numberField(metadata, 'comparedPairCount', '比较 Prompt 对'),
        numberField(metadata, 'violatingPairCount', '视觉重合对'),
        numberField(metadata, 'visualOverlapRate', '视觉重合度（%）'),
        { label: '重合判定阈值', value: EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD },
      ]);
    case 'QUALITY_GATE':
      return compact([
        numberField(metadata, 'acceptedCount', '最终通过'),
        numberField(metadata, 'targetCount', '目标数量'),
        numberField(metadata, 'semanticDuplicateRate', '语义重复度（%）'),
        numberField(metadata, 'visualOverlapRate', '视觉重合度（%）'),
        numberField(metadata, 'removedCount', '累计剔除'),
        numberField(metadata, 'replenishmentRound', '补齐轮次'),
        enumField(metadata, 'qualityStatus', '质量状态', ['PASS', 'NEEDS_REVIEW']),
      ]);
    case 'INSIGHT_COVERAGE':
      return compact([
        numberField(metadata, 'requiredCount', '必须覆盖信息'),
        numberField(metadata, 'coveredCount', '已覆盖信息'),
        numberField(metadata, 'missingCount', '缺失信息'),
        numberField(metadata, 'appliedConstraintCount', '已应用约束'),
      ]);
    case 'REPLENISH':
      return compact([
        numberField(metadata, 'replenishmentRound', '补齐轮次'),
        numberField(metadata, 'missingCount', '补齐前缺口'),
        numberField(metadata, 'plannedCandidateCount', '补齐候选'),
        numberField(metadata, 'pendingShardCount', '待生成分片'),
      ]);
    case 'RESULT_SAVE':
      return compact([
        numberField(metadata, 'batchSize', '已保存 Prompt'),
        enumField(metadata, 'qualityStatus', '质量状态', ['PASS', 'NEEDS_REVIEW']),
      ]);
    case 'LOAD_AND_SNAPSHOT':
      return [];
  }
};

const actualFields = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
  metadata: unknown,
): EffectPromptNodeDetailField[] => {
  if (nodeId === 'LOAD_AND_SNAPSHOT') {
    const insight = insightResult(run);
    const settings = inputSettings(run);
    return compact([
      textField('产品名称', insightText(insight, 'productName', 'product_name')),
      textField('产品品类', insightText(insight, 'productCategory', 'product_category')),
      settings ? { label: '语义重复度上限', value: `${settings.semanticLimit}%` } : null,
      settings ? { label: '画面重合度上限', value: `${settings.visualLimit}%` } : null,
      { label: '保留人工内容', value: retainedPrompts(run).length },
      ...(settings
        ? EFFECT_PROMPT_FRAGMENT_TYPES.map((type) => ({
            label: EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[type],
            value: `${settings.fragmentConfigs[type].count} 条 · ${settings.fragmentConfigs[type].durationSeconds} 秒`,
          }))
        : []),
    ]);
  }
  const stageFields = nodeMetricFields(nodeId, metadata);
  const allCandidates = candidates(run);
  const generationType = GENERATION_FRAGMENT_BY_NODE[nodeId];
  if (generationType) {
    const generated = allCandidates.filter((item) => item.fragmentType === generationType);
    return [
      ...stageFields,
      {
        label: '可执行候选',
        value: generated.filter((item) => !item.invalidReasons.length).length,
      },
      { label: '门禁未通过', value: generated.filter((item) => item.invalidReasons.length).length },
    ];
  }
  if (nodeId === 'NORMALIZATION')
    return [
      ...stageFields,
      { label: '候选总数', value: allCandidates.length },
      {
        label: '可执行候选',
        value: allCandidates.filter((item) => !item.invalidReasons.length).length,
      },
      {
        label: '门禁未通过',
        value: allCandidates.filter((item) => item.invalidReasons.length).length,
      },
    ];
  const result = finalResult(run);
  if (nodeId === 'QUALITY_GATE' && result)
    return [
      { label: '最终通过', value: result.metrics.acceptedCount },
      { label: '目标数量', value: result.metrics.targetCount },
      { label: '语义重复度', value: `${result.metrics.semanticDuplicateRate}%` },
      { label: '画面重合度', value: `${result.metrics.visualOverlapRate}%` },
      {
        label: '累计剔除',
        value:
          result.metrics.removedSemanticDuplicates +
          result.metrics.removedVisualDuplicates +
          result.metrics.removedDimensionConflicts +
          result.metrics.removedExecutionInvalid,
      },
      { label: '质量状态', value: result.qualityStatus },
    ];
  if (nodeId === 'RESULT_SAVE' && result)
    return [
      { label: '已保存 Prompt', value: result.items.length },
      { label: '质量状态', value: result.qualityStatus },
      {
        label: '卖点覆盖',
        value: `${result.metrics.sellingPointCoverage.covered.length}/${result.metrics.sellingPointCoverage.required.length}`,
      },
    ];
  return stageFields;
};

const actualBlocks = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
): EffectPromptNodeDetailBlock[] => {
  const blocks: Array<EffectPromptNodeDetailBlock | null> = [];
  const insight = insightResult(run);
  const allCombinations = combinations(run);
  const allCandidates = candidates(run);
  const validCandidates = allCandidates.filter((item) => !item.invalidReasons.length);
  const result = finalResult(run);

  if (nodeId === 'LOAD_AND_SNAPSHOT') {
    blocks.push(
      tagBlock('本次使用的营销信息', [
        tagGroup('核心卖点', insightList(insight, 'coreSellingPoints', 'core_selling_points')),
        tagGroup('继承禁用项', insightList(insight, 'disabledElements', 'disabled_elements')),
      ]),
    );
  } else if (nodeId === 'INSIGHT_MAPPING') {
    blocks.push(
      tagBlock('实际映射的提炼信息', [
        tagGroup('产品与品类', [
          insightText(insight, 'productName', 'product_name'),
          insightText(insight, 'productCategory', 'product_category'),
        ]),
        tagGroup('核心卖点', insightList(insight, 'coreSellingPoints', 'core_selling_points')),
        tagGroup('核心痛点', insightList(insight, 'corePainPoints', 'core_pain_points')),
        tagGroup('目标受众', [insightText(insight, 'targetAudience', 'target_audience')]),
        tagGroup('使用场景', insightList(insight, 'usageScenarios', 'usage_scenarios')),
      ]),
    );
  } else if (nodeId === 'STRATEGY_PLANNING') {
    blocks.push(
      tagBlock('本批次实际采用的策略', [
        ...EFFECT_PROMPT_DIMENSIONS.map(({ key, label }) =>
          tagGroup(
            label,
            allCombinations.map((item) => item.dimensions[key]),
          ),
        ),
        tagGroup(
          '连续动作',
          allCombinations.map((item) => item.visibleAction),
        ),
        tagGroup(
          '证据模式',
          allCombinations.map((item) => item.evidenceMode),
        ),
      ]),
    );
  } else if (nodeId === 'DIMENSION_COMBINATION') {
    blocks.push(combinationBlock('实际片段蓝图', allCombinations));
  } else if (nodeId === 'FRAGMENT_TYPE_ROUTER') {
    blocks.push(routeBlock(run, '六类实际路由结果'));
  } else if (GENERATION_FRAGMENT_BY_NODE[nodeId]) {
    const type = GENERATION_FRAGMENT_BY_NODE[nodeId]!;
    blocks.push(
      promptBlock(
        '实际候选 Prompt',
        allCandidates.filter((item) => item.fragmentType === type),
      ),
    );
  } else if (nodeId === 'NORMALIZATION') {
    const reasonMap = new Map<string, { count: number; examples: string[] }>();
    for (const item of allCandidates) {
      for (const code of item.invalidReasons) {
        const issue = reasonMap.get(code) ?? { count: 0, examples: [] };
        issue.count += 1;
        issue.examples.push(item.content);
        reasonMap.set(code, issue);
      }
    }
    blocks.push(
      promptBlock('标准化后的可执行 Prompt', validCandidates),
      issueBlock(
        '执行门禁未通过原因',
        [...reasonMap].map(([code, issue]) => ({ code, ...issue })),
      ),
    );
  } else if (nodeId === 'SEMANTIC_DEDUP') {
    blocks.push(
      pairBlock('实际语义相似 Prompt 对', 'SEMANTIC', [
        ...retainedPrompts(run),
        ...validCandidates,
      ]),
    );
  } else if (nodeId === 'VISUAL_DEDUP') {
    blocks.push(
      pairBlock('实际视觉重合 Prompt 对', 'VISUAL', [...retainedPrompts(run), ...validCandidates]),
    );
  } else if (nodeId === 'INSIGHT_COVERAGE' && result) {
    const coverage = result.metrics.insightCoverage;
    blocks.push(
      tagBlock('提炼信息实际覆盖结果', [
        tagGroup('必须覆盖', insightReferenceValues(coverage.required)),
        tagGroup('已覆盖', insightReferenceValues(coverage.covered)),
        tagGroup('仍缺失', insightReferenceValues(coverage.missing)),
        tagGroup('自适应使用', insightReferenceValues(coverage.adaptive)),
        tagGroup('已应用约束', insightReferenceValues(coverage.appliedConstraints)),
      ]),
    );
  } else if (nodeId === 'QUALITY_GATE' && result) {
    const finalCounts = Object.fromEntries(
      result.metrics.fragmentTypeDistribution.map(({ fragmentType: type, actualCount }) => [
        type,
        actualCount,
      ]),
    ) as Record<EffectPromptFragmentType, number>;
    blocks.push(
      routeBlock(run, '六类质量门禁结果', finalCounts),
      tagBlock('卖点覆盖结果', [
        tagGroup('已覆盖卖点', result.metrics.sellingPointCoverage.covered),
        tagGroup('缺失卖点', result.metrics.sellingPointCoverage.missing),
      ]),
      issueBlock('质量剔除结果', [
        { code: 'SEMANTIC_DUPLICATE', count: result.metrics.removedSemanticDuplicates },
        { code: 'VISUAL_OVERLAP', count: result.metrics.removedVisualDuplicates },
        { code: 'DIMENSION_CONFLICT', count: result.metrics.removedDimensionConflicts },
        ...result.metrics.executionInvalidReasons,
      ]),
    );
  } else if (nodeId === 'REPLENISH') {
    const replenished = allCandidates.filter((item) => item.round > 0);
    blocks.push(
      replenished.length
        ? promptBlock('实际补齐 Prompt', replenished)
        : combinationBlock(
            '实际补齐组合',
            allCombinations.filter((item) => item.round > 0),
          ),
    );
  } else if (nodeId === 'RESULT_SAVE' && result) {
    const finalCounts = Object.fromEntries(
      result.metrics.fragmentTypeDistribution.map(({ fragmentType: type, actualCount }) => [
        type,
        actualCount,
      ]),
    ) as Record<EffectPromptFragmentType, number>;
    blocks.push(
      routeBlock(run, '最终六类分布', finalCounts),
      tagBlock('最终卖点覆盖', [
        tagGroup('已覆盖卖点', result.metrics.sellingPointCoverage.covered),
        tagGroup('缺失卖点', result.metrics.sellingPointCoverage.missing),
      ]),
      promptBlock('最终保存 Prompt', result.items),
    );
  }
  return blocks.filter((block): block is EffectPromptNodeDetailBlock => block !== null);
};

export const presentEffectPromptNodeDetail = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
): GetEffectPromptNodeDetailData['detail'] => {
  const stage = run.stages.find((item) => item.nodeId === nodeId);
  return {
    nodeId,
    status: stage?.status ?? 'PENDING',
    summary: publicText(stage?.summary, 500),
    fields: actualFields(run, nodeId, stage?.metadata),
    blocks: actualBlocks(run, nodeId),
    warnings: safeStrings(stage?.warnings, 20),
    errorMessage: stage?.errorMessage ? publicText(stage.errorMessage, 1000) : null,
    updatedAt: stage?.updatedAt.toISOString() ?? null,
  };
};
