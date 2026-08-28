import { createHash } from 'node:crypto';

import type {
  EffectPromptBatchSettings,
  EffectPromptBatchSettingsV5,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptNodeDetailBlock,
  EffectPromptNodeDetailBlueprint,
  EffectPromptNodeDetailCreativeSample,
  EffectPromptNodeDetailField,
  EffectPromptNodeDetailPrompt,
  EffectPromptNodeDetailSection,
  EffectPromptNodeId,
  EffectPromptQualityScores,
  GetEffectPromptNodeDetailData,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_MAX_RUN_ATTEMPTS,
  EFFECT_PROMPT_NODE_DETAIL_LIMITS,
} from '@ai-marketing/contracts';

import type { EffectPromptNodeDetailRunRecord } from './effect-prompt.repository';
import {
  EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD,
  EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD,
  isEffectPromptSettings,
  isEffectPromptSettingsV5,
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

type Relationship = {
  bundleId: string;
  fragmentType: EffectPromptFragmentType;
  primaryFactId: string;
  factIds: string[];
  creativeIntent: string;
  blueprintQuota: number;
};

type Coordinate = {
  coordinateId: string;
  fragmentType: EffectPromptFragmentType;
  dimension: keyof EffectPromptDimensions;
  value: string;
  compatibleBundleIds: string[];
  sourceFactIds: string[];
};

const GENERATION_FRAGMENT_BY_NODE: Partial<Record<EffectPromptNodeId, EffectPromptFragmentType>> = {
  GENERATE_HOOK: 'HOOK',
  GENERATE_PAIN: 'PAIN',
  GENERATE_PRODUCT_DISPLAY: 'PRODUCT_DISPLAY',
  GENERATE_SELLING_POINT_EXPLANATION: 'SELLING_POINT_EXPLANATION',
  GENERATE_CTA: 'CTA',
  GENERATE_OUTRO: 'OUTRO',
};

const RELATIONSHIP_FRAGMENT_BY_NODE: Partial<Record<EffectPromptNodeId, EffectPromptFragmentType>> =
  {
    PLAN_HOOK_RELATIONSHIPS: 'HOOK',
    PLAN_PAIN_RELATIONSHIPS: 'PAIN',
    PLAN_PRODUCT_DISPLAY_RELATIONSHIPS: 'PRODUCT_DISPLAY',
    PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS: 'SELLING_POINT_EXPLANATION',
    PLAN_CTA_RELATIONSHIPS: 'CTA',
    PLAN_OUTRO_RELATIONSHIPS: 'OUTRO',
  };

const COORDINATE_FRAGMENT_BY_NODE: Partial<Record<EffectPromptNodeId, EffectPromptFragmentType>> = {
  PLAN_HOOK_COORDINATES: 'HOOK',
  PLAN_PAIN_COORDINATES: 'PAIN',
  PLAN_PRODUCT_DISPLAY_COORDINATES: 'PRODUCT_DISPLAY',
  PLAN_SELLING_POINT_EXPLANATION_COORDINATES: 'SELLING_POINT_EXPLANATION',
  PLAN_CTA_COORDINATES: 'CTA',
  PLAN_OUTRO_COORDINATES: 'OUTRO',
};

const BLUEPRINT_FRAGMENT_BY_NODE: Partial<Record<EffectPromptNodeId, EffectPromptFragmentType>> = {
  GENERATE_HOOK_BLUEPRINTS: 'HOOK',
  GENERATE_PAIN_BLUEPRINTS: 'PAIN',
  GENERATE_PRODUCT_DISPLAY_BLUEPRINTS: 'PRODUCT_DISPLAY',
  GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS: 'SELLING_POINT_EXPLANATION',
  GENERATE_CTA_BLUEPRINTS: 'CTA',
  GENERATE_OUTRO_BLUEPRINTS: 'OUTRO',
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
  CTA_NO_SAFE_AREA: '转化片段没有形成可供后续文案使用的安全留白',
  EVIDENCE_MODE_MISMATCH: '卖点画面与允许呈现的证据类型不一致',
  FACT_OVERLOAD: '单条片段承载了过多提炼事实',
  HOOK_RESOLVED: '钩子片段提前揭晓了答案或解决方案',
  META_LANGUAGE: '包含策划元话语',
  MULTI_STAGE_STORY: '片段包含多个叙事阶段',
  NO_VISIBLE_ACTION: '缺少可拍摄的连续动作',
  NEGATIVE_TAIL_DUPLICATION: '重复附加了长篇禁用说明',
  OVERLOADED_ACTION: '单条片段包含多个主要动作',
  OUTRO_NEW_MESSAGE: '片尾品牌片段重新引入了卖点或新信息',
  OUTRO_UNSTABLE: '片尾品牌片段仍包含明显运动，无法稳定定格',
  PAIN_RESOLVED: '痛点片段在同一镜头中完成了解决',
  PLACEHOLDER_TEXT: '正文存在占位描述',
  PRODUCT_NOT_FIRST_FRAME: '产品展示片段没有在首帧建立清楚产品主体',
  PRODUCT_ROLE_OVERLOAD: '产品展示片段混入了效果或解决方案',
  PROMPT_LENGTH_MISMATCH: '正文长度与目标片段时长不匹配',
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

const publicMultilineText = (value: unknown, maxLength = 30_000): string =>
  String(value ?? '')
    .replace(/data:[^\s,]+;base64,[a-z\d+/=]+/giu, '[图片数据已隐藏]')
    .replace(/[a-z\d+/]{256,}={0,2}/giu, '[Base64 数据已隐藏]')
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '[链接已隐藏]')
    .replace(/[a-z]:\\(?:[^\\\s]+\\)+[^\s]+/giu, '[本地路径已隐藏]')
    .split(/\r?\n/gu)
    .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n')
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
  const entries = EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [
    key,
    publicText(
      key === 'productRelation' ? (value.productRelation ?? value.sellingPoint) : value[key],
      240,
    ),
  ]);
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

const inputSettings = (
  run: EffectPromptNodeDetailRunRecord,
): EffectPromptBatchSettings | EffectPromptBatchSettingsV5 | null => {
  const settings = inputSnapshot(run).settings;
  return isEffectPromptSettings(settings) || isEffectPromptSettingsV5(settings) ? settings : null;
};

const dimensionValue = (
  dimensionsValue: EffectPromptNodeDetailPrompt['dimensions'],
  key: keyof EffectPromptDimensions,
): string =>
  key === 'productRelation'
    ? 'productRelation' in dimensionsValue
      ? dimensionsValue.productRelation
      : dimensionsValue.sellingPoint
    : dimensionsValue[key];

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
    if (shard.phase === 'BLUEPRINT') continue;
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
    if (shard.phase === 'BLUEPRINT') continue;
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
    Object.entries(item.dimensions).map(([key, value]) => [key, publicText(value, 240)]),
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
  phase: 'BLUEPRINT' | 'PROMPT' = 'PROMPT',
): EffectPromptNodeDetailBlock | null => {
  const settings = inputSettings(run);
  if (!settings) return null;
  const allCandidates = candidates(run);
  const rows = EFFECT_PROMPT_FRAGMENT_TYPES.map((type) => {
    const typeShards = run.shards.filter(
      (shard) =>
        shard.phase === phase &&
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
      targetCount:
        'fragmentConfigs' in settings
          ? settings.fragmentConfigs[type].count
          : Math.ceil(settings.targetCount / EFFECT_PROMPT_FRAGMENT_TYPES.length),
      candidateCount:
        finalCounts?.[type] ??
        (phase === 'BLUEPRINT'
          ? blueprints(run).filter((item) => item.fragmentType === type).length
          : allCandidates.filter((item) => item.fragmentType === type).length),
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

const checkpointPlan = (value: unknown): JsonRecord => {
  const checkpoint = metadataRecord(metadataRecord(value).checkpoint);
  return metadataRecord(checkpoint.plan);
};

const collectStringLeaves = (value: unknown, output: string[] = []): string[] => {
  if (typeof value === 'string') {
    const cleaned = publicText(value, 500);
    if (cleaned) output.push(cleaned);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringLeaves(item, output));
    return output;
  }
  if (isRecord(value)) Object.values(value).forEach((item) => collectStringLeaves(item, output));
  return output;
};

const factValueLookup = (run: EffectPromptNodeDetailRunRecord): Map<string, string> => {
  const result = new Map<string, string>();
  for (const value of collectStringLeaves(insightResult(run))) {
    const digest = createHash('sha256').update(normalizedValue(value)).digest('hex').slice(0, 20);
    if (!result.has(digest)) result.set(digest, value);
  }
  return result;
};

const displayFact = (lookup: Map<string, string>, factId: string): string => {
  const digest = factId.includes(':') ? factId.slice(factId.lastIndexOf(':') + 1) : '';
  return lookup.get(digest) ?? '已确认事实（当前阶段未提供展示文本）';
};

const relationships = (run: EffectPromptNodeDetailRunRecord): Relationship[] => {
  const quotaByBundle = new Map<string, number>();
  for (const shard of run.shards) {
    if (shard.phase !== 'BLUEPRINT') continue;
    for (const raw of Array.isArray(shard.combinationPlan) ? shard.combinationPlan : []) {
      if (!isRecord(raw)) continue;
      const bundleId = publicText(raw.bundleId, 120);
      if (bundleId) quotaByBundle.set(bundleId, (quotaByBundle.get(bundleId) ?? 0) + 1);
    }
  }
  const rows: Relationship[] = [];
  for (const stage of run.stages) {
    if (!stage.nodeId.endsWith('_RELATIONSHIPS')) continue;
    const plan = checkpointPlan(stage.metadata);
    for (const raw of Array.isArray(plan.bundles) ? plan.bundles : []) {
      if (!isRecord(raw)) continue;
      const type = fragmentType(raw.fragmentType);
      const bundleId = publicText(raw.bundleId, 120);
      const primaryFactId = publicText(raw.primaryFactId, 120);
      const factIds = safeStrings(raw.factIds, 8);
      const creativeIntent = publicText(raw.creativeIntent, 500);
      if (!type || !bundleId || !primaryFactId || !factIds.length || !creativeIntent) continue;
      rows.push({
        bundleId,
        fragmentType: type,
        primaryFactId,
        factIds,
        creativeIntent,
        blueprintQuota: quotaByBundle.get(bundleId) ?? 0,
      });
    }
  }
  return rows.filter(
    (item, index, items) => items.findIndex(({ bundleId }) => bundleId === item.bundleId) === index,
  );
};

const coordinates = (run: EffectPromptNodeDetailRunRecord): Coordinate[] => {
  const groups: Array<[keyof EffectPromptDimensions, string]> = [
    ['narrative', 'narratives'],
    ['scene', 'scenes'],
    ['persona', 'personas'],
    ['productRelation', 'sellingPoints'],
    ['camera', 'cameras'],
    ['emotion', 'emotions'],
  ];
  const rows: Coordinate[] = [];
  for (const stage of run.stages) {
    if (!stage.nodeId.endsWith('_COORDINATES')) continue;
    const plan = checkpointPlan(stage.metadata);
    const type = fragmentType(plan.fragmentType);
    if (!type) continue;
    for (const [dimension, key] of groups) {
      for (const raw of Array.isArray(plan[key]) ? plan[key] : []) {
        if (!isRecord(raw)) continue;
        const coordinateId = publicText(raw.coordinateId, 120);
        const value = publicText(raw.value, 240);
        const compatibleBundleIds = safeStrings(raw.compatibleBundleIds, 16);
        if (!coordinateId || !value || !compatibleBundleIds.length) continue;
        rows.push({
          coordinateId,
          fragmentType: type,
          dimension,
          value,
          compatibleBundleIds,
          sourceFactIds: safeStrings(raw.sourceFactIds, 8),
        });
      }
    }
  }
  return rows.filter(
    (item, index, items) =>
      items.findIndex(
        ({ coordinateId, fragmentType: type }) =>
          coordinateId === item.coordinateId && type === item.fragmentType,
      ) === index,
  );
};

const blueprints = (run: EffectPromptNodeDetailRunRecord): EffectPromptNodeDetailBlueprint[] => {
  const coordinateById = new Map(
    coordinates(run).map((item) => [`${item.fragmentType}:${item.coordinateId}`, item]),
  );
  const relationshipById = new Map(
    relationships(run).map((item) => [item.bundleId, item.creativeIntent]),
  );
  const rows: EffectPromptNodeDetailBlueprint[] = [];
  for (const shard of run.shards) {
    if (shard.phase !== 'BLUEPRINT') continue;
    const taskBySlot = new Map<string, JsonRecord>();
    for (const raw of Array.isArray(shard.combinationPlan) ? shard.combinationPlan : []) {
      if (!isRecord(raw)) continue;
      const slotId = publicText(raw.slotId, 160);
      if (slotId) taskBySlot.set(slotId, raw);
    }
    for (const raw of Array.isArray(shard.items) ? shard.items : []) {
      if (!isRecord(raw)) continue;
      const slotId = publicText(raw.slotId, 160);
      const type = fragmentType(raw.fragmentType);
      const task = taskBySlot.get(slotId);
      const duration = safeNumber(task?.targetDurationSeconds);
      const ordinal = safeNumber(task?.ordinal);
      const bundleId = publicText(raw.bundleId, 120);
      const coordinateIds: Record<keyof EffectPromptDimensions, string> = {
        narrative: publicText(raw.narrativeCoordinateId, 120),
        scene: publicText(raw.sceneCoordinateId, 120),
        persona: publicText(raw.personaCoordinateId, 120),
        productRelation: publicText(raw.sellingPointCoordinateId, 120),
        camera: publicText(raw.cameraCoordinateId, 120),
        emotion: publicText(raw.emotionCoordinateId, 120),
      };
      const itemDimensions = Object.fromEntries(
        EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [
          key,
          type ? coordinateById.get(`${type}:${coordinateIds[key]}`)?.value : undefined,
        ]),
      ) as EffectPromptDimensions;
      if (
        !slotId ||
        !type ||
        duration === null ||
        ordinal === null ||
        EFFECT_PROMPT_DIMENSIONS.some(({ key }) => !itemDimensions[key])
      )
        continue;
      rows.push({
        title: `蓝图 ${String(ordinal).padStart(3, '0')}`,
        fragmentType: type,
        relationshipTitle: relationshipById.get(bundleId) ?? '所属营销组合',
        targetDurationSeconds: duration,
        dimensions: itemDimensions,
        openingState: publicText(raw.openingState, 500),
        actionArc: publicText(raw.actionArc, 800),
        endingState: publicText(raw.endingState, 500),
      });
    }
  }
  return rows.filter(
    (item, index, items) =>
      items.findIndex(
        (candidate) =>
          candidate.title === item.title && candidate.fragmentType === item.fragmentType,
      ) === index,
  );
};

const blueprintDistance = (
  left: EffectPromptNodeDetailBlueprint,
  right: EffectPromptNodeDetailBlueprint,
): number =>
  EFFECT_PROMPT_DIMENSIONS.reduce(
    (total, { key }) =>
      total +
      (normalizedValue(left.dimensions[key]) === normalizedValue(right.dimensions[key]) ? 0 : 1),
    0,
  );

const relationshipBlock = (
  run: EffectPromptNodeDetailRunRecord,
  title: string,
  items: Relationship[],
): EffectPromptNodeDetailBlock | null => {
  const facts = factValueLookup(run);
  const visible = items.slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples).map((item) => ({
    title: item.creativeIntent,
    fragmentType: item.fragmentType,
    primaryFact: displayFact(facts, item.primaryFactId),
    auxiliaryFacts: item.factIds
      .filter((factId) => factId !== item.primaryFactId)
      .map((factId) => displayFact(facts, factId)),
    creativeIntent: item.creativeIntent,
    blueprintQuota: item.blueprintQuota,
  }));
  return visible.length ? { kind: 'RELATIONSHIP_LIST', title, items: visible } : null;
};

const coordinateBlock = (
  run: EffectPromptNodeDetailRunRecord,
  title: string,
  items: Coordinate[],
): EffectPromptNodeDetailBlock | null => {
  const facts = factValueLookup(run);
  const groups = EFFECT_PROMPT_DIMENSIONS.flatMap(({ key, label }) => {
    const coordinatesForDimension = items
      .filter(({ dimension }) => dimension === key)
      .slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxTagValues)
      .map((item) => ({
        value: item.value,
        compatibleBundleCount: item.compatibleBundleIds.length,
        sourceFacts: item.sourceFactIds.map((factId) => displayFact(facts, factId)),
      }));
    return coordinatesForDimension.length
      ? [{ dimension: key, label, items: coordinatesForDimension }]
      : [];
  });
  return groups.length ? { kind: 'COORDINATE_LIST', title, groups } : null;
};

const blueprintBlock = (
  title: string,
  items: EffectPromptNodeDetailBlueprint[],
): EffectPromptNodeDetailBlock | null => {
  const visible = items.slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples);
  return visible.length ? { kind: 'BLUEPRINT_LIST', title, items: visible } : null;
};

const orthogonalBlock = (
  title: string,
  items: EffectPromptNodeDetailBlueprint[],
): EffectPromptNodeDetailBlock | null => {
  const pairs: Extract<EffectPromptNodeDetailBlock, { kind: 'ORTHOGONAL_PAIR_LIST' }>['items'] = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex]!;
      const right = items[rightIndex]!;
      const distance = blueprintDistance(left, right);
      if (distance >= 3) continue;
      pairs.push({
        distance,
        sameDimensions: EFFECT_PROMPT_DIMENSIONS.flatMap(({ key }) =>
          normalizedValue(left.dimensions[key]) === normalizedValue(right.dimensions[key])
            ? [key]
            : [],
        ),
        left,
        right,
      });
    }
  }
  const visible = pairs.slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples);
  return visible.length ? { kind: 'ORTHOGONAL_PAIR_LIST', title, items: visible } : null;
};

const semanticSignature = (item: EffectPromptNodeDetailPrompt): string =>
  [
    item.fragmentType,
    item.dimensions.narrative,
    dimensionValue(item.dimensions, 'productRelation'),
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
          (normalizedValue(dimensionValue(left.dimensions, key)) ===
          normalizedValue(dimensionValue(right.dimensions, key))
            ? visualWeights[key]
            : 0),
        0,
      );
      if (score < EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD) continue;
      const reasons = visualKeys.flatMap(([key, label]) =>
        normalizedValue(dimensionValue(left.dimensions, key as keyof EffectPromptDimensions)) ===
        normalizedValue(dimensionValue(right.dimensions, key as keyof EffectPromptDimensions))
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
    case 'SHARED_PROMPT_COMPILATION':
      return compact([
        numberField(metadata, 'sectionCount', '共用段落'),
        numberField(metadata, 'disabledElementCount', '禁用元素'),
        textField(
          '共用提示词',
          metadata.sharedPromptGenerated === true
            ? '已编译'
            : metadata.sharedPromptGenerated === false
              ? '当前为空'
              : null,
        ),
        textField(
          '用户补充',
          metadata.hasUserAdditionalContent === true
            ? '已应用'
            : metadata.hasUserAdditionalContent === false
              ? '未设置'
              : null,
        ),
      ]);
    case 'COHERENT_CREATIVE_GENERATION':
      return compact([
        numberField(metadata, 'targetCount', '目标创意'),
        numberField(metadata, 'candidateCount', '已生成创意'),
        numberField(metadata, 'completedShardCount', '完成分片'),
      ]);
    case 'CREATIVE_EVALUATION_CLASSIFICATION':
      return compact([
        numberField(metadata, 'evaluatedCount', '已评估创意'),
        numberField(metadata, 'acceptedCount', '通过评估'),
        numberField(metadata, 'rejectedCount', '未通过评估'),
      ]);
    case 'EXACT_SELECTION_AND_SUPPLEMENT':
      return compact([
        numberField(metadata, 'targetCount', '目标数量'),
        numberField(metadata, 'selectedCount', '已择优保留'),
        numberField(metadata, 'supplementedCount', '补充数量'),
      ]);
    case 'ITEM_EVALUATE':
      return compact([
        numberField(metadata, 'evaluatedCount', '已评估 Prompt'),
        enumField(metadata, 'classificationStatus', '用途评估', ['PENDING', 'VERIFIED']),
      ]);
    case 'STRATEGY_PLANNING':
      return compact([
        numberField(metadata, 'relationshipBundleCount', '营销关系束'),
        numberField(metadata, 'modelRelationshipBundleCount', '模型有效规划'),
        numberField(metadata, 'workerCompletedRelationshipBundleCount', '系统安全补齐'),
        numberField(metadata, 'plannedFactCount', '已规划事实'),
      ]);
    case 'GLOBAL_FACT_ALLOCATION':
      return compact([
        numberField(metadata, 'fragmentTypeCount', '已分配片段类型'),
        numberField(metadata, 'mandatoryFactCount', '必须承载事实'),
        numberField(metadata, 'bundleTargetCount', '目标创意母版'),
      ]);
    case 'STRATEGY_FRAGMENT_ROUTER':
      return compact([
        numberField(metadata, 'branchCount', '规划分支'),
        numberField(metadata, 'reusedCheckpointCount', '复用成功分支'),
      ]);
    case 'PLAN_HOOK_STRATEGY':
    case 'PLAN_PAIN_STRATEGY':
    case 'PLAN_PRODUCT_DISPLAY_STRATEGY':
    case 'PLAN_SELLING_POINT_EXPLANATION_STRATEGY':
    case 'PLAN_CTA_STRATEGY':
    case 'PLAN_OUTRO_STRATEGY':
      return compact([
        numberField(metadata, 'targetBundleCount', '目标母版'),
        numberField(metadata, 'actualBundleCount', '实际母版'),
        numberField(metadata, 'mandatoryFactCount', '必须事实'),
        numberField(metadata, 'coveredMandatoryFactCount', '已覆盖必须事实'),
        textField('检查点', metadata.reusedCheckpoint === true ? '已复用' : '本次生成'),
      ]);
    case 'STRATEGY_MERGE_VALIDATION':
      return compact([
        numberField(metadata, 'completedBranchCount', '完成规划分支'),
        numberField(metadata, 'relationshipBundleCount', '已合并创意母版'),
        numberField(metadata, 'plannedFactCount', '已规划事实'),
      ]);
    case 'RELATIONSHIP_FRAGMENT_ROUTER':
      return compact([
        numberField(metadata, 'branchCount', '营销组合分支'),
        numberField(metadata, 'reusedCheckpointCount', '复用成功分支'),
      ]);
    case 'PLAN_HOOK_RELATIONSHIPS':
    case 'PLAN_PAIN_RELATIONSHIPS':
    case 'PLAN_PRODUCT_DISPLAY_RELATIONSHIPS':
    case 'PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS':
    case 'PLAN_CTA_RELATIONSHIPS':
    case 'PLAN_OUTRO_RELATIONSHIPS':
      return compact([
        numberField(metadata, 'targetBundleCount', '目标营销组合'),
        numberField(metadata, 'actualBundleCount', '实际营销组合'),
        numberField(metadata, 'plannedFactCount', '已规划事实'),
        textField('检查点', metadata.reusedCheckpoint === true ? '已复用' : '本次生成'),
      ]);
    case 'RELATIONSHIP_MERGE_VALIDATION':
      return compact([
        numberField(metadata, 'completedBranchCount', '完成组合分支'),
        numberField(metadata, 'relationshipBundleCount', '已合并营销组合'),
        numberField(metadata, 'plannedFactCount', '已规划事实'),
      ]);
    case 'DIMENSION_COORDINATE_ROUTER':
      return compact([
        numberField(metadata, 'branchCount', '坐标规划分支'),
        numberField(metadata, 'reusedCheckpointCount', '复用成功分支'),
      ]);
    case 'PLAN_HOOK_COORDINATES':
    case 'PLAN_PAIN_COORDINATES':
    case 'PLAN_PRODUCT_DISPLAY_COORDINATES':
    case 'PLAN_SELLING_POINT_EXPLANATION_COORDINATES':
    case 'PLAN_CTA_COORDINATES':
    case 'PLAN_OUTRO_COORDINATES':
      return compact([
        numberField(metadata, 'coordinateCount', '六维坐标候选'),
        numberField(metadata, 'compatibleBundleCount', '适用营销组合'),
        textField('检查点', metadata.reusedCheckpoint === true ? '已复用' : '本次生成'),
      ]);
    case 'COORDINATE_MERGE_VALIDATION':
      return compact([
        numberField(metadata, 'completedBranchCount', '完成坐标分支'),
        numberField(metadata, 'coordinateCount', '已合并坐标候选'),
        numberField(metadata, 'invalidCoordinateCount', '无效坐标'),
      ]);
    case 'BLUEPRINT_QUOTA_ALLOCATION':
      return compact([
        numberField(metadata, 'relationshipBundleCount', '参与营销组合'),
        numberField(metadata, 'targetBlueprintCount', '目标蓝图'),
        numberField(metadata, 'candidateBlueprintCount', '候选蓝图'),
      ]);
    case 'BLUEPRINT_FRAGMENT_ROUTER':
      return compact([
        numberField(metadata, 'fragmentTypeCount', '路由类型'),
        numberField(metadata, 'totalShards', '蓝图分片总数'),
        numberField(metadata, 'routedShards', '已路由分片'),
      ]);
    case 'GENERATE_HOOK_BLUEPRINTS':
    case 'GENERATE_PAIN_BLUEPRINTS':
    case 'GENERATE_PRODUCT_DISPLAY_BLUEPRINTS':
    case 'GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS':
    case 'GENERATE_CTA_BLUEPRINTS':
    case 'GENERATE_OUTRO_BLUEPRINTS':
      return compact([
        numberField(metadata, 'targetCount', '目标蓝图'),
        numberField(metadata, 'candidateCount', '实际蓝图'),
        numberField(metadata, 'totalShards', '分片总数'),
        numberField(metadata, 'completedShards', '完成分片'),
        numberField(metadata, 'failedShards', '失败分片'),
      ]);
    case 'BLUEPRINT_ORTHOGONAL_GATE':
      return compact([
        numberField(metadata, 'comparedPairCount', '全批次比较对数'),
        numberField(metadata, 'acceptedCount', '正交通过蓝图'),
        numberField(metadata, 'rejectedCount', '差异不足蓝图'),
        numberField(metadata, 'missingCount', '待补齐蓝图'),
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
      settings && 'semanticLimit' in settings
        ? { label: '语义重复度上限', value: `${settings.semanticLimit}%` }
        : null,
      settings && 'visualLimit' in settings
        ? { label: '画面重合度上限', value: `${settings.visualLimit}%` }
        : null,
      settings && 'targetCount' in settings
        ? { label: '目标数量', value: `${settings.targetCount} 条` }
        : null,
      settings && 'defaultDurationSeconds' in settings
        ? { label: '统一时长', value: `${settings.defaultDurationSeconds} 秒` }
        : null,
      { label: '保留人工内容', value: retainedPrompts(run).length },
      ...(settings && 'fragmentConfigs' in settings
        ? EFFECT_PROMPT_FRAGMENT_TYPES.map((type) => ({
            label: EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[type],
            value: `${settings.fragmentConfigs[type].count} 条 · ${settings.fragmentConfigs[type].durationSeconds} 秒`,
          }))
        : []),
    ]);
  }
  const stageFields = nodeMetricFields(nodeId, metadata);
  const allCandidates = candidates(run);
  const allRelationships = relationships(run);
  const relationshipType = RELATIONSHIP_FRAGMENT_BY_NODE[nodeId];
  if (relationshipType) {
    const planned = allRelationships.filter((item) => item.fragmentType === relationshipType);
    return [
      ...stageFields,
      { label: '实际营销组合', value: planned.length },
      { label: '分配蓝图', value: planned.reduce((total, item) => total + item.blueprintQuota, 0) },
    ];
  }
  const allCoordinates = coordinates(run);
  const coordinateType = COORDINATE_FRAGMENT_BY_NODE[nodeId];
  if (coordinateType) {
    const planned = allCoordinates.filter((item) => item.fragmentType === coordinateType);
    return [
      ...stageFields,
      { label: '实际坐标候选', value: planned.length },
      {
        label: '覆盖维度',
        value: new Set(planned.map((item) => item.dimension)).size,
      },
    ];
  }
  const allBlueprints = blueprints(run);
  const blueprintType = BLUEPRINT_FRAGMENT_BY_NODE[nodeId];
  if (blueprintType) {
    const generated = allBlueprints.filter((item) => item.fragmentType === blueprintType);
    return [...stageFields, { label: '实际生成蓝图', value: generated.length }];
  }
  if (nodeId === 'BLUEPRINT_ORTHOGONAL_GATE') {
    const pairCount = (allBlueprints.length * Math.max(0, allBlueprints.length - 1)) / 2;
    let conflictCount = 0;
    for (let left = 0; left < allBlueprints.length; left += 1)
      for (let right = left + 1; right < allBlueprints.length; right += 1)
        if (blueprintDistance(allBlueprints[left]!, allBlueprints[right]!) < 3) conflictCount += 1;
    return [
      ...stageFields,
      { label: '实际蓝图', value: allBlueprints.length },
      { label: '全批次比较对数', value: pairCount },
      { label: '差异不足对数', value: conflictCount },
    ];
  }
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
  const allRelationships = relationships(run);
  const allCoordinates = coordinates(run);
  const allBlueprints = blueprints(run);

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
  } else if (RELATIONSHIP_FRAGMENT_BY_NODE[nodeId]) {
    const type = RELATIONSHIP_FRAGMENT_BY_NODE[nodeId]!;
    blocks.push(
      relationshipBlock(
        run,
        `${EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[type]}实际营销组合`,
        allRelationships.filter((item) => item.fragmentType === type),
      ),
    );
  } else if (nodeId === 'RELATIONSHIP_MERGE_VALIDATION') {
    blocks.push(relationshipBlock(run, '本批次已校验营销组合', allRelationships));
  } else if (COORDINATE_FRAGMENT_BY_NODE[nodeId]) {
    const type = COORDINATE_FRAGMENT_BY_NODE[nodeId]!;
    blocks.push(
      coordinateBlock(
        run,
        `${EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[type]}实际六维坐标`,
        allCoordinates.filter((item) => item.fragmentType === type),
      ),
    );
  } else if (nodeId === 'COORDINATE_MERGE_VALIDATION') {
    blocks.push(coordinateBlock(run, '本批次已校验六维坐标', allCoordinates));
  } else if (nodeId === 'BLUEPRINT_QUOTA_ALLOCATION') {
    blocks.push(relationshipBlock(run, '营销组合蓝图配额', allRelationships));
  } else if (nodeId === 'BLUEPRINT_FRAGMENT_ROUTER') {
    blocks.push(routeBlock(run, '六类蓝图实际路由结果', undefined, 'BLUEPRINT'));
  } else if (BLUEPRINT_FRAGMENT_BY_NODE[nodeId]) {
    const type = BLUEPRINT_FRAGMENT_BY_NODE[nodeId]!;
    blocks.push(
      blueprintBlock(
        `${EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[type]}实际蓝图`,
        allBlueprints.filter((item) => item.fragmentType === type),
      ),
    );
  } else if (nodeId === 'BLUEPRINT_ORTHOGONAL_GATE') {
    blocks.push(
      orthogonalBlock('实际六维差异不足蓝图对', allBlueprints),
      blueprintBlock('正交校验蓝图样例', allBlueprints),
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

type V11CreativeRow = {
  slotId: string;
  ordinal: number;
  targetDurationSeconds: number;
  creativeCore: string;
  declaredFactIds: string[];
  dimensions: EffectPromptDimensions;
  content: string;
};

type V11EvaluationRow = {
  slotId: string;
  primaryPurpose: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
  scores: EffectPromptQualityScores;
  hardIssues: string[];
  warnings: string[];
};

const graphVersion = (run: EffectPromptNodeDetailRunRecord): string =>
  publicText(inputSnapshot(run).graphVersion, 80);

const isV11Run = (run: EffectPromptNodeDetailRunRecord): boolean =>
  graphVersion(run) === 'V11_COHERENT_CREATIVE_GENERATION';

const purposeList = (value: unknown): EffectPromptFragmentType[] =>
  (Array.isArray(value) ? value : [])
    .map(fragmentType)
    .filter((item): item is EffectPromptFragmentType => item !== null)
    .filter((item, index, items) => items.indexOf(item) === index);

const qualityScores = (value: unknown): EffectPromptQualityScores | null => {
  const raw = metadataRecord(value);
  const parsed = {
    productRelevance: safeNumber(raw.productRelevance),
    creativeCoherence: safeNumber(raw.creativeCoherence),
    visualExecutability: safeNumber(raw.visualExecutability),
    commercialUsefulness: safeNumber(raw.commercialUsefulness),
    visualClarity: safeNumber(raw.visualClarity),
  };
  return Object.values(parsed).every((score) => score !== null)
    ? (parsed as EffectPromptQualityScores)
    : null;
};

const v11CreativeRows = (run: EffectPromptNodeDetailRunRecord): V11CreativeRow[] => {
  const taskBySlot = new Map<string, JsonRecord>();
  for (const shard of run.shards) {
    for (const raw of Array.isArray(shard.combinationPlan) ? shard.combinationPlan : []) {
      if (!isRecord(raw) || !Array.isArray(raw.preferredFactIds)) continue;
      const slotId = publicText(raw.slotId, 160);
      if (slotId) taskBySlot.set(slotId, raw);
    }
  }
  const rows: V11CreativeRow[] = [];
  for (const shard of run.shards) {
    for (const raw of Array.isArray(shard.items) ? shard.items : []) {
      if (!isRecord(raw) || typeof raw.creativeCore !== 'string') continue;
      const slotId = publicText(raw.slotId, 160);
      const ordinal = safeNumber(raw.ordinal);
      const itemDimensions = dimensions(raw.dimensions);
      const content = publicText(raw.content);
      const task = taskBySlot.get(slotId) ?? {};
      const duration = safeNumber(task.targetDurationSeconds);
      const creativeCore = publicText(raw.creativeCore, 300);
      if (!slotId || ordinal === null || !itemDimensions || !content || duration === null) continue;
      rows.push({
        slotId,
        ordinal,
        targetDurationSeconds: duration,
        creativeCore,
        declaredFactIds: safeStrings(raw.declaredFactIds, 12),
        dimensions: itemDimensions,
        content,
      });
    }
  }
  return rows
    .filter(
      (item, index, items) =>
        items.findIndex(
          (candidate) => candidate.slotId === item.slotId && candidate.content === item.content,
        ) === index,
    )
    .sort((left, right) => left.ordinal - right.ordinal);
};

const v11EvaluationRows = (run: EffectPromptNodeDetailRunRecord): V11EvaluationRow[] => {
  const rows: V11EvaluationRow[] = [];
  for (const shard of run.shards) {
    for (const raw of Array.isArray(shard.items) ? shard.items : []) {
      if (!isRecord(raw) || !isRecord(raw.scores)) continue;
      const slotId = publicText(raw.slotId, 160);
      const primaryPurpose = fragmentType(raw.primaryPurpose);
      const compatiblePurposes = purposeList(raw.compatiblePurposes);
      const scores = qualityScores(raw.scores);
      if (!slotId || !primaryPurpose || !scores) continue;
      rows.push({
        slotId,
        primaryPurpose,
        compatiblePurposes: compatiblePurposes.includes(primaryPurpose)
          ? compatiblePurposes
          : [primaryPurpose, ...compatiblePurposes],
        scores,
        hardIssues: safeStrings(raw.hardIssues, 20),
        warnings: safeStrings(raw.warnings, 20),
      });
    }
  }
  return rows.filter(
    (item, index, items) => items.findIndex(({ slotId }) => slotId === item.slotId) === index,
  );
};

const issueLabels = (codes: string[]): string[] =>
  codes.map((code) => ISSUE_LABELS[code] ?? publicText(code, 120));

const creativeSamples = (
  run: EffectPromptNodeDetailRunRecord,
): EffectPromptNodeDetailCreativeSample[] => {
  const evaluationBySlot = new Map(v11EvaluationRows(run).map((item) => [item.slotId, item]));
  const lookup = factValueLookup(run);
  return v11CreativeRows(run).map((item) => {
    const evaluation = evaluationBySlot.get(item.slotId);
    return {
      code: promptCode(item.ordinal),
      creativeCore: item.creativeCore,
      dimensions: item.dimensions,
      content: item.content,
      sourceFacts: item.declaredFactIds
        .map((factId) => displayFact(lookup, factId))
        .filter((value, index, values) => values.indexOf(value) === index),
      primaryPurpose: evaluation?.primaryPurpose ?? null,
      compatiblePurposes: evaluation?.compatiblePurposes ?? [],
      productRelevance: evaluation?.scores.productRelevance ?? null,
      scores: evaluation?.scores ?? null,
      outcome: !evaluation ? 'PENDING' : evaluation.hardIssues.length ? 'REJECTED' : 'ACCEPTED',
      reasons: evaluation
        ? issueLabels(evaluation.hardIssues.length ? evaluation.hardIssues : evaluation.warnings)
        : [],
    };
  });
};

const finalV6Record = (run: EffectPromptNodeDetailRunRecord): JsonRecord | null => {
  const raw = run.result ? metadataRecord(run.result.draftResult) : {};
  return raw.schemaVersion === 6 ? raw : null;
};

const finalV6Samples = (
  run: EffectPromptNodeDetailRunRecord,
): EffectPromptNodeDetailCreativeSample[] => {
  const result = finalV6Record(run);
  if (!result) return [];
  return (Array.isArray(result.items) ? result.items : []).flatMap((value) => {
    if (!isRecord(value)) return [];
    const itemDimensions = dimensions(value.dimensions);
    const content = publicText(value.content);
    const code = publicText(value.code, 40);
    const primaryPurpose = fragmentType(value.primaryPurpose ?? value.fragmentType);
    const compatiblePurposes = purposeList(value.compatiblePurposes);
    const relevance = safeNumber(value.productRelevance);
    if (!itemDimensions || !content || !code || !primaryPurpose) return [];
    const bindings = (Array.isArray(value.insightBindings) ? value.insightBindings : []).flatMap(
      (binding) => {
        if (!isRecord(binding)) return [];
        const factValue = publicText(binding.value, 400);
        return factValue ? [factValue] : [];
      },
    );
    return [
      {
        code,
        creativeCore: itemDimensions.narrative,
        dimensions: itemDimensions,
        content,
        sourceFacts: bindings.filter((item, index, items) => items.indexOf(item) === index),
        primaryPurpose,
        compatiblePurposes: compatiblePurposes.includes(primaryPurpose)
          ? compatiblePurposes
          : [primaryPurpose, ...compatiblePurposes],
        productRelevance: relevance,
        scores: null,
        outcome: 'SAVED' as const,
        reasons: [],
      },
    ];
  });
};

const creativeSampleBlock = (
  title: string,
  items: EffectPromptNodeDetailCreativeSample[],
  totalCount = items.length,
): EffectPromptNodeDetailBlock | null => {
  const visible = items.slice(0, EFFECT_PROMPT_NODE_DETAIL_LIMITS.maxSamples);
  return visible.length
    ? {
        kind: 'CREATIVE_SAMPLE_LIST',
        title,
        totalCount,
        remainingCount: Math.max(0, totalCount - visible.length),
        items: visible,
      }
    : null;
};

const textContentBlock = (
  title: string,
  content: unknown,
  sourceLabels: string[],
): EffectPromptNodeDetailBlock | null => {
  const safeContent = publicMultilineText(content, 30_000);
  return safeContent
    ? {
        kind: 'TEXT_CONTENT',
        title,
        content: safeContent,
        sourceLabels: safeStrings(sourceLabels, 12),
      }
    : null;
};

const averageQualityScores = (rows: V11EvaluationRow[]): EffectPromptQualityScores | null => {
  if (!rows.length) return null;
  const total = rows.reduce(
    (sum, item) => ({
      productRelevance: sum.productRelevance + item.scores.productRelevance,
      creativeCoherence: sum.creativeCoherence + item.scores.creativeCoherence,
      visualExecutability: sum.visualExecutability + item.scores.visualExecutability,
      commercialUsefulness: sum.commercialUsefulness + item.scores.commercialUsefulness,
      visualClarity: sum.visualClarity + item.scores.visualClarity,
    }),
    {
      productRelevance: 0,
      creativeCoherence: 0,
      visualExecutability: 0,
      commercialUsefulness: 0,
      visualClarity: 0,
    },
  );
  return Object.fromEntries(
    Object.entries(total).map(([key, value]) => [key, Math.round((value / rows.length) * 10) / 10]),
  ) as EffectPromptQualityScores;
};

const scoreFields = (scores: EffectPromptQualityScores | null): EffectPromptNodeDetailField[] =>
  scores
    ? [
        { label: '产品相关性', value: scores.productRelevance },
        { label: '创意连贯性', value: scores.creativeCoherence },
        { label: '画面可执行性', value: scores.visualExecutability },
        { label: '商业素材价值', value: scores.commercialUsefulness },
        { label: '视觉表达清晰度', value: scores.visualClarity },
      ]
    : [];

const v11AdditionalOutputFields = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
  metadata: JsonRecord,
): EffectPromptNodeDetailField[] => {
  const samples = creativeSamples(run);
  const evaluations = v11EvaluationRows(run);
  const result = finalV6Record(run);
  const resultMetrics = metadataRecord(result?.metrics);
  if (nodeId === 'COHERENT_CREATIVE_GENERATION')
    return [
      { label: '实际生成创意', value: samples.length },
      {
        label: '完成分片',
        value: run.shards.filter(
          (shard) =>
            shard.phase === 'BLUEPRINT' &&
            shard.status === 'SUCCEEDED' &&
            (Array.isArray(shard.items) ? shard.items : []).some(
              (item) => isRecord(item) && typeof item.creativeCore === 'string',
            ),
        ).length,
      },
    ];
  if (nodeId === 'CREATIVE_EVALUATION_CLASSIFICATION' || nodeId === 'ITEM_EVALUATE')
    return [
      { label: '实际完成评估', value: evaluations.length },
      { label: '通过评估', value: evaluations.filter((item) => !item.hardIssues.length).length },
      { label: '未通过评估', value: evaluations.filter((item) => item.hardIssues.length).length },
      ...scoreFields(averageQualityScores(evaluations)),
    ];
  if (nodeId === 'EXACT_SELECTION_AND_SUPPLEMENT')
    return compact([
      numberField(metadata, 'acceptedCount', '已择优保留'),
      numberField(metadata, 'targetCount', '目标数量'),
      numberField(metadata, 'missingCount', '当前缺口'),
      numberField(metadata, 'exactDuplicateCount', '完全重复淘汰'),
      numberField(metadata, 'fixedAnchorCount', '固定参照 Prompt'),
      numberField(metadata, 'embeddingInputCount', '向量化正文'),
      numberField(metadata, 'embeddingRequestCount', '向量请求'),
      numberField(metadata, 'embeddingDurationMs', '向量阶段耗时（毫秒）'),
      numberField(metadata, 'localComparisonMs', '本地矩阵耗时（毫秒）'),
      numberField(metadata, 'initialRedundantCandidateCount', '补充前高风险冗余'),
      numberField(metadata, 'finalRedundantCandidateCount', '补充后高风险冗余'),
      textField(
        'MMR 权重',
        typeof metadata.mmrQualityWeight === 'number' &&
          typeof metadata.mmrDiversityWeight === 'number'
          ? `质量 ${Math.round(metadata.mmrQualityWeight * 100)}% / 多样性 ${Math.round(metadata.mmrDiversityWeight * 100)}%`
          : null,
      ),
      textField('数量补充', metadata.supplemented === true ? '已执行' : '未触发'),
      textField(
        '多样性补充',
        metadata.diversitySupplementTriggered === true
          ? `已补充 ${typeof metadata.diversitySupplementCount === 'number' ? metadata.diversitySupplementCount : 0} 条候选`
          : '未触发',
      ),
    ]);
  if (nodeId === 'RESULT_SAVE' && result)
    return compact([
      { label: '已保存 Prompt', value: (Array.isArray(result.items) ? result.items : []).length },
      numberField(resultMetrics, 'targetCount', '目标数量'),
      textField('质量状态', result.qualityStatus),
      { label: '提交状态', value: '已保存为节点草稿，尚未提交工作副本' },
      ...scoreFields(qualityScores(resultMetrics.averageScores)),
    ]);
  return [];
};

const uniqueFields = (fields: EffectPromptNodeDetailField[]): EffectPromptNodeDetailField[] =>
  fields.filter(
    (field, index, items) => items.findIndex(({ label }) => label === field.label) === index,
  );

const metadataFactGroups = (metadata: JsonRecord): Array<ReturnType<typeof tagGroup>> => {
  const group = (label: string, key: string) =>
    tagGroup(
      label,
      (Array.isArray(metadata[key]) ? metadata[key] : []).flatMap((item) => {
        if (!isRecord(item)) return [];
        const value = publicText(item.value, 400);
        return value ? [value] : [];
      }),
    );
  return [
    group('必须应用', 'requiredFacts'),
    group('自适应应用', 'adaptiveFacts'),
    group('不参与生成', 'excludedFacts'),
    group('全局约束', 'appliedConstraints'),
  ];
};

const sharedPromptData = (
  run: EffectPromptNodeDetailRunRecord,
  metadata: JsonRecord,
): JsonRecord => {
  if (publicText(metadata.compiledContent)) return metadata;
  const resultPrompt = metadataRecord(finalV6Record(run)?.sharedPrompt);
  if (publicText(resultPrompt.compiledContent)) return resultPrompt;
  return metadataRecord(inputSnapshot(run).sharedPrompt);
};

const purposeDistributionBlock = (
  run: EffectPromptNodeDetailRunRecord,
): EffectPromptNodeDetailBlock | null => {
  const metrics = metadataRecord(finalV6Record(run)?.metrics);
  const distribution = (
    Array.isArray(metrics.purposeDistribution) ? metrics.purposeDistribution : []
  ).flatMap((item) => {
    if (!isRecord(item)) return [];
    const purpose = fragmentType(item.purpose);
    const primaryCount = safeNumber(item.primaryCount);
    const compatibleCount = safeNumber(item.compatibleCount);
    return purpose && primaryCount !== null && compatibleCount !== null
      ? [
          `${EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[purpose]}：主用途 ${primaryCount} 条，兼容 ${compatibleCount} 条`,
        ]
      : [];
  });
  return tagBlock('最终推荐用途分布', [tagGroup('用途分布', distribution)]);
};

const v11OutputBlocks = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
  metadata: JsonRecord,
): EffectPromptNodeDetailBlock[] => {
  const blocks: Array<EffectPromptNodeDetailBlock | null> = [];
  const samples = creativeSamples(run);
  const evaluations = v11EvaluationRows(run);
  if (nodeId === 'LOAD_AND_SNAPSHOT') {
    blocks.push(...actualBlocks(run, nodeId));
  } else if (nodeId === 'INSIGHT_MAPPING') {
    const mapped = tagBlock('提炼信息应用结果', metadataFactGroups(metadata));
    blocks.push(mapped ?? actualBlocks(run, nodeId)[0] ?? null);
  } else if (nodeId === 'SHARED_PROMPT_COMPILATION') {
    const prompt = sharedPromptData(run, metadata);
    const sectionLabels = (Array.isArray(prompt.sections) ? prompt.sections : []).flatMap(
      (item) => {
        if (!isRecord(item)) return [];
        const title = publicText(item.title, 120);
        return title ? [title] : [];
      },
    );
    blocks.push(textContentBlock('最终共用提示词', prompt.compiledContent, sectionLabels));
  } else if (nodeId === 'COHERENT_CREATIVE_GENERATION') {
    blocks.push(creativeSampleBlock('真实创意候选样例', samples, samples.length));
  } else if (nodeId === 'CREATIVE_EVALUATION_CLASSIFICATION' || nodeId === 'ITEM_EVALUATE') {
    const accepted = samples.filter((item) => item.outcome === 'ACCEPTED');
    const rejected = samples.filter((item) => item.outcome === 'REJECTED');
    const hardCounts = new Map<string, number>();
    for (const evaluation of evaluations)
      for (const issue of evaluation.hardIssues)
        hardCounts.set(issue, (hardCounts.get(issue) ?? 0) + 1);
    blocks.push(
      creativeSampleBlock('通过评估的创意样例', accepted, accepted.length),
      creativeSampleBlock('未通过评估的创意样例', rejected, rejected.length),
      issueBlock(
        '未通过原因',
        [...hardCounts].map(([code, count]) => ({ code, count })),
      ),
    );
  } else if (nodeId === 'EXACT_SELECTION_AND_SUPPLEMENT') {
    const saved = finalV6Samples(run);
    const accepted = samples
      .filter((item) => item.outcome === 'ACCEPTED')
      .map((item) => ({ ...item, outcome: 'SELECTED' as const }));
    blocks.push(
      creativeSampleBlock(
        saved.length ? '最终择优 Prompt 样例' : '当前合格候选样例',
        saved.length ? saved.map((item) => ({ ...item, outcome: 'SELECTED' as const })) : accepted,
        saved.length || accepted.length,
      ),
    );
  } else if (nodeId === 'RESULT_SAVE') {
    const saved = finalV6Samples(run);
    blocks.push(
      purposeDistributionBlock(run),
      creativeSampleBlock('最终保存 Prompt 样例', saved, saved.length),
    );
  }
  return blocks.filter((block): block is EffectPromptNodeDetailBlock => block !== null);
};

const expectedOutputSummary: Partial<Record<EffectPromptNodeId, string>> = {
  LOAD_AND_SNAPSHOT: '将锁定本次商品、营销洞察、数量、时长与共用约束。',
  INSIGHT_MAPPING: '将营销洞察划分为必须应用、自适应应用、排除信息和全局约束。',
  SHARED_PROMPT_COMPILATION: '将禁用元素与用户补充内容合并为一段批次共用提示词。',
  COHERENT_CREATIVE_GENERATION: '将生成围绕同一创意主线的六维信息与干净 Prompt 正文。',
  CREATIVE_EVALUATION_CLASSIFICATION: '将给出质量判断、推荐主用途、兼容用途和问题原因。',
  EXACT_SELECTION_AND_SUPPLEMENT: '将按质量与差异选满目标数量，候选不足时执行一次定向补充。',
  RESULT_SAVE: '将最佳结果保存为节点草稿，完成校验前不会提交工作副本。',
  ITEM_EVALUATE: '将重新评估当前条目的产品关联、质量与推荐用途。',
};

const v11InputSections = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
): Pick<EffectPromptNodeDetailSection, 'summary' | 'fields' | 'blocks'> => {
  const insight = insightResult(run);
  const settings = inputSettings(run);
  const samples = creativeSamples(run);
  const evaluations = v11EvaluationRows(run);
  const retainedCount = retainedPrompts(run).length;
  const base = compact([
    textField('当前商品', insightText(insight, 'productName', 'product_name')),
    textField('商品品类', insightText(insight, 'productCategory', 'product_category')),
  ]);
  if (nodeId === 'LOAD_AND_SNAPSHOT')
    return {
      summary: '读取已提交的营销洞察和本节点批次设置。',
      fields: [
        ...base,
        ...(settings && 'targetCount' in settings
          ? [
              { label: '目标数量', value: `${settings.targetCount} 条` },
              { label: '统一时长', value: `${settings.defaultDurationSeconds} 秒` },
            ]
          : []),
        { label: '保留人工内容', value: retainedCount },
      ],
      blocks: [],
    };
  if (nodeId === 'INSIGHT_MAPPING')
    return {
      summary: '接收上游已确认的产品事实和营销洞察。',
      fields: base,
      blocks: actualBlocks(run, 'INSIGHT_MAPPING'),
    };
  if (nodeId === 'SHARED_PROMPT_COMPILATION') {
    const disabled = insightList(insight, 'disabledElements', 'disabled_elements');
    const existing = metadataRecord(inputSnapshot(run).sharedPrompt);
    const userContent = (Array.isArray(existing.sections) ? existing.sections : []).flatMap(
      (item) =>
        isRecord(item) && item.source === 'USER' ? [publicText(item.content, 30_000)] : [],
    );
    return {
      summary: '接收上游禁用元素和本批次用户补充内容。',
      fields: [
        { label: '禁用元素', value: disabled.length },
        { label: '用户补充', value: userContent.some(Boolean) ? '已设置' : '未设置' },
      ],
      blocks: [
        tagBlock('上游禁用元素', [tagGroup('禁用元素', disabled)]),
        textContentBlock('用户补充内容', userContent.filter(Boolean).join('\n'), ['用户补充']),
      ].filter((block): block is EffectPromptNodeDetailBlock => block !== null),
    };
  }
  if (nodeId === 'COHERENT_CREATIVE_GENERATION')
    return {
      summary: '接收可用营销事实、统一时长和已编译的共用约束。',
      fields: compact([
        settings && 'targetCount' in settings
          ? { label: '最终目标', value: `${settings.targetCount} 条` }
          : null,
        settings && 'defaultDurationSeconds' in settings
          ? { label: '统一时长', value: `${settings.defaultDurationSeconds} 秒` }
          : null,
        {
          label: '共用约束',
          value: publicText(sharedPromptData(run, {}).compiledContent) ? '已启用' : '未设置',
        },
      ]),
      blocks: actualBlocks(run, 'INSIGHT_MAPPING'),
    };
  if (nodeId === 'CREATIVE_EVALUATION_CLASSIFICATION' || nodeId === 'ITEM_EVALUATE')
    return {
      summary:
        nodeId === 'ITEM_EVALUATE' ? '接收待重新评估的单条 Prompt。' : '接收已生成的创意候选。',
      fields: [{ label: '待评估候选', value: samples.length }],
      blocks: [creativeSampleBlock('待评估创意样例', samples, samples.length)].filter(
        (block): block is EffectPromptNodeDetailBlock => block !== null,
      ),
    };
  if (nodeId === 'EXACT_SELECTION_AND_SUPPLEMENT') {
    const qualified = evaluations.filter((item) => !item.hardIssues.length).length;
    return {
      summary: '接收已经完成质量评估的候选池和目标数量。',
      fields: compact([
        settings && 'targetCount' in settings
          ? { label: '目标数量', value: `${settings.targetCount} 条` }
          : null,
        { label: '合格候选', value: qualified },
        { label: '保留人工内容', value: retainedCount },
      ]),
      blocks: [],
    };
  }
  if (nodeId === 'RESULT_SAVE') {
    const finalSamples = finalV6Samples(run);
    const selectedCount =
      finalSamples.length || evaluations.filter((item) => !item.hardIssues.length).length;
    return {
      summary: '接收已经择优且完成用途评估的 Prompt。',
      fields: compact([
        { label: '待保存结果', value: selectedCount },
        settings && 'targetCount' in settings
          ? { label: '目标数量', value: `${settings.targetCount} 条` }
          : null,
        {
          label: '共用提示词',
          value: publicText(sharedPromptData(run, {}).compiledContent) ? '已包含' : '未设置',
        },
      ]),
      blocks: [],
    };
  }
  return { summary: '接收上一阶段已经完成的业务结果。', fields: base, blocks: [] };
};

const sectionState = (
  status: GetEffectPromptNodeDetailData['detail']['status'],
  hasContent: boolean,
): EffectPromptNodeDetailSection['state'] => {
  if (status === 'PENDING') return 'EXPECTED';
  if (status === 'RUNNING' || status === 'PARTIAL' || status === 'FAILED')
    return hasContent ? 'PARTIAL' : 'EMPTY';
  return hasContent ? 'ACTUAL' : 'EMPTY';
};

const buildDetailSections = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
  status: GetEffectPromptNodeDetailData['detail']['status'],
  metadataValue: unknown,
): EffectPromptNodeDetailSection[] => {
  const metadata = metadataRecord(metadataValue);
  const legacyFields = actualFields(run, nodeId, metadata);
  const legacyBlocks = actualBlocks(run, nodeId);
  const input = isV11Run(run)
    ? v11InputSections(run, nodeId)
    : {
        summary: '接收历史工作流上一阶段已经确认的业务结果。',
        fields: nodeId === 'LOAD_AND_SNAPSHOT' ? legacyFields : [],
        blocks: nodeId === 'LOAD_AND_SNAPSHOT' ? legacyBlocks : [],
      };
  const outputFields = isV11Run(run)
    ? uniqueFields([...legacyFields, ...v11AdditionalOutputFields(run, nodeId, metadata)])
    : nodeId === 'LOAD_AND_SNAPSHOT'
      ? []
      : legacyFields;
  const outputBlocks = isV11Run(run)
    ? v11OutputBlocks(run, nodeId, metadata)
    : nodeId === 'LOAD_AND_SNAPSHOT'
      ? []
      : legacyBlocks;
  const outputHasContent = outputFields.length > 0 || outputBlocks.length > 0;
  const outputState = sectionState(status, outputHasContent);
  return [
    {
      kind: 'INPUT',
      state: input.fields.length || input.blocks.length ? 'ACTUAL' : 'EMPTY',
      title: '本次输入',
      summary: input.summary,
      fields: input.fields,
      blocks: input.blocks,
    },
    {
      kind: 'OUTPUT',
      state: outputState,
      title:
        outputState === 'EXPECTED'
          ? '预计输出'
          : outputState === 'PARTIAL'
            ? '已完成部分'
            : '本次输出',
      summary:
        status === 'PENDING'
          ? (expectedOutputSummary[nodeId] ?? '该节点执行后将在这里展示真实业务结果。')
          : nodeId === 'RESULT_SAVE' && outputHasContent
            ? '结果已保存为节点草稿；只有完成校验后才会提交 Prompt 工作副本。'
            : outputHasContent
              ? publicText(run.stages.find((item) => item.nodeId === nodeId)?.summary, 500)
              : status === 'FAILED'
                ? '当前没有可展示的业务输出，请查看下方失败原因。'
                : '当前阶段没有额外可展示的业务结果。',
      fields: outputFields,
      blocks: outputBlocks,
    },
    {
      kind: 'EXECUTION',
      state: status === 'PENDING' ? 'EXPECTED' : 'ACTUAL',
      title: '执行情况',
      summary:
        status === 'PENDING'
          ? '任务开始后将展示尝试次数和阶段进度。'
          : '这里展示安全的运行进度，不包含模型和内部调用信息。',
      fields: compact([
        safeNumber(run.attemptCount) === null
          ? null
          : {
              label: '任务尝试',
              value: `${run.attemptCount}/${EFFECT_PROMPT_MAX_RUN_ATTEMPTS}`,
            },
        numberField(metadata, 'completedShardCount', '完成分片'),
        numberField(metadata, 'pendingShardCount', '待处理分片'),
        numberField(metadata, 'round', '当前轮次'),
      ]),
      blocks: [],
    },
  ];
};

export const presentEffectPromptNodeDetail = (
  run: EffectPromptNodeDetailRunRecord,
  nodeId: EffectPromptNodeId,
): GetEffectPromptNodeDetailData['detail'] => {
  const stage = run.stages.find((item) => item.nodeId === nodeId);
  const terminalFailure =
    run.status === 'FAILED' && run.currentNode === nodeId && stage?.status === 'RUNNING';
  const status = terminalFailure ? 'FAILED' : (stage?.status ?? 'PENDING');
  return {
    nodeId,
    status,
    summary: publicText(stage?.summary, 500),
    sections: buildDetailSections(run, nodeId, status, stage?.metadata),
    fields: actualFields(run, nodeId, stage?.metadata),
    blocks: actualBlocks(run, nodeId),
    warnings: safeStrings(stage?.warnings, 20),
    errorMessage: terminalFailure
      ? publicText(run.errorMessage, 1000)
      : stage?.errorMessage
        ? publicText(stage.errorMessage, 1000)
        : null,
    updatedAt: terminalFailure
      ? run.updatedAt.toISOString()
      : (stage?.updatedAt.toISOString() ?? null),
  };
};
