import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptMetrics,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_SCHEMA_VERSION,
  effectPromptFragmentTypeTargetCounts,
  normalizeEffectPromptSettings,
} from '@ai-marketing/contracts';
import type { EffectPromptInputSnapshot } from './effect-prompt.types';

export const EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD = 0.82;
export const EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD = 0.75;
const visualWeights: Record<'scene' | 'persona' | 'camera' | 'emotion', number> = {
  scene: 0.35,
  persona: 0.2,
  camera: 0.3,
  emotion: 0.15,
};

const itemTextLimits = {
  id: 160,
  code: 40,
  content: 12_000,
} as const;
const dimensionTextLimits: Record<keyof EffectPromptDimensions, number> = {
  narrative: 120,
  scene: 120,
  persona: 160,
  sellingPoint: 240,
  camera: 160,
  emotion: 120,
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizedValue = (value: string): string =>
  value.normalize('NFC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ');

const semanticText = (value: string): string =>
  normalizedValue(value)
    .replace(/(?:视频)?时长\s*[:：]?\s*\d+\s*(?:秒|s)/giu, '')
    .replace(/(?:画幅|比例)\s*[:：]?\s*\d+\s*[:：x×]\s*\d+/giu, '')
    .replace(/(?:投放)?渠道\s*[:：][^。；;\n]+/giu, '')
    .replace(/(?:合规|禁用元素|注意事项)\s*[:：][^。；;\n]+/giu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');

const trigrams = (value: string): Set<string> => {
  const characters = [...semanticText(value)];
  if (characters.length < 3) return new Set(characters.length ? [characters.join('')] : []);
  return new Set(
    characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join('')),
  );
};

export const trigramDice = (left: string, right: string): number => {
  const a = trigrams(left);
  const b = trigrams(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
};

const signature = (item: EffectPromptItem): string =>
  ['narrative', 'sellingPoint', 'scene']
    .map((key) => normalizedValue(item.dimensions[key as keyof EffectPromptDimensions]))
    .join('|');

export const dimensionDistance = (left: EffectPromptItem, right: EffectPromptItem): number =>
  EFFECT_PROMPT_DIMENSIONS.reduce(
    (distance, dimension) =>
      distance +
      Number(
        normalizedValue(left.dimensions[dimension.key]) !==
          normalizedValue(right.dimensions[dimension.key]),
      ),
    0,
  );

export const visualOverlap = (left: EffectPromptItem, right: EffectPromptItem): number =>
  (Object.keys(visualWeights) as Array<keyof typeof visualWeights>).reduce(
    (score, key) =>
      score +
      (normalizedValue(left.dimensions[key]) === normalizedValue(right.dimensions[key])
        ? visualWeights[key]
        : 0),
    0,
  );

export const promptPairViolationRate = (violations: number, count: number): number => {
  const totalPairs = (count * (count - 1)) / 2;
  return totalPairs === 0
    ? 0
    : Math.floor((violations * 10_000 + totalPairs / 2) / totalPairs) / 100;
};

const validDimensions = (value: unknown): value is EffectPromptDimensions => {
  const candidate = record(value);
  return Boolean(
    candidate &&
    Object.keys(candidate).length === EFFECT_PROMPT_DIMENSIONS.length &&
    EFFECT_PROMPT_DIMENSIONS.every(
      ({ key }) =>
        typeof candidate[key] === 'string' &&
        candidate[key].trim().length > 0 &&
        candidate[key].length <= dimensionTextLimits[key],
    ),
  );
};

const validDateTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const META_LANGUAGE =
  /(?:^(?:痛点前置型|效果展示型|场景代入型|科普讲解型|对比测评型|开箱体验型)\s*[：:]|【?(?:叙事结构|场景变量|人物变量|卖点侧重|镜头语言|情绪基调|内容结构|创意核心|差异化设定)】?\s*[：=]|完成(?:单一)?卖点表达|围绕[^。；\n]+表达|产品特点自然出镜|根据(?:以上|要求|信息卡)|本条\s*prompt|视频生成方案|不(?:得|要)添加未经确认|禁止(?:夸大|未确认)|不得发明)/iu;
const ABSTRACT_PERSONA = /(?:目标人群|受众|消费者|用户群体|家庭决策者|爱好者|全国消费者|人群)/u;
const FULL_TIMELINE =
  /(?:\d+(?:\.\d+)?\s*[-—~至]\s*\d+(?:\.\d+)?\s*(?:秒|s)|第[一二三四五六\d]+镜|镜头[一二三四五六\d]+|分镜|时间轴|切换|切至|镜头转到|转场|硬切|叠化|闪白|蒙太奇)/iu;
const PHASE_MARKERS = /(?:前段|中段|后段|开头|随后|然后|接着|最后|结尾|收束)/gu;
const VISIBLE_ACTION =
  /(?:拿起|放下|打开|关闭|取出|倒入|切开|撕开|按压|涂抹|喷洒|擦拭|冲洗|折叠|展开|安装|装入|推拉|旋转|搅拌|加热|品尝|摆放|对比|揭开|翻转|挤出|穿戴|使用)/u;
const PLACEHOLDER_TEXT =
  /(?:待补充|以信息卡为准|自然出镜|相关细节|关键特点|适当|高级感|真实使用动作|当前产品名|指定卖点|当前场景|当前人物)/u;

export const effectPromptExecutionIssues = (item: EffectPromptItem): string[] => {
  const issues: string[] = [];
  const content = item.content.normalize('NFC');
  if (META_LANGUAGE.test(content)) issues.push('META_LANGUAGE');
  if (ABSTRACT_PERSONA.test(`${item.dimensions.persona} ${content}`))
    issues.push('ABSTRACT_PERSONA');
  const phases = new Set(content.match(PHASE_MARKERS) ?? []);
  if (FULL_TIMELINE.test(content) || phases.size >= 2) issues.push('FULL_TIMELINE_NOT_FRAGMENT');
  if (!VISIBLE_ACTION.test(content)) issues.push('NO_VISIBLE_ACTION');
  if (PLACEHOLDER_TEXT.test(content)) issues.push('PLACEHOLDER_TEXT');
  return issues;
};

export const isEffectPromptItem = (value: unknown): value is EffectPromptItem => {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    item.id.length <= itemTextLimits.id &&
    typeof item.code === 'string' &&
    item.code.trim().length > 0 &&
    item.code.length <= itemTextLimits.code &&
    (item.origin === 'AI' || item.origin === 'MANUAL') &&
    typeof item.fragmentType === 'string' &&
    EFFECT_PROMPT_FRAGMENT_TYPES.includes(item.fragmentType as EffectPromptFragmentType) &&
    Array.isArray(item.materialTags) &&
    item.materialTags.length > 0 &&
    item.materialTags.length <= EFFECT_PROMPT_LIMITS.maxMaterialTags &&
    item.materialTags.every(
      (tag) => typeof tag === 'string' && tag.trim().length > 0 && tag.length <= 120,
    ) &&
    new Set(item.materialTags.map(normalizedValue)).size === item.materialTags.length &&
    Number.isInteger(item.targetDurationSeconds) &&
    Number(item.targetDurationSeconds) >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
    Number(item.targetDurationSeconds) <= EFFECT_PROMPT_LIMITS.maxDurationSeconds &&
    validDimensions(item.dimensions) &&
    typeof item.content === 'string' &&
    item.content.trim().length > 0 &&
    item.content.length <= itemTextLimits.content &&
    typeof item.manualEdited === 'boolean' &&
    validDateTime(item.createdAt) &&
    validDateTime(item.updatedAt) &&
    Object.keys(item).length === 11,
  );
};

export const isEffectPromptSettings = (value: unknown): value is EffectPromptBatchSettings => {
  const settings = record(value);
  if (!settings) return false;
  const fragmentTypeWeights = record(settings.fragmentTypeWeights);
  if (!fragmentTypeWeights) return false;
  return (
    Object.keys(settings).length === 8 &&
    Number.isInteger(settings.count) &&
    Number(settings.count) >= EFFECT_PROMPT_LIMITS.minCount &&
    Number(settings.count) <= EFFECT_PROMPT_LIMITS.maxCount &&
    Number.isInteger(settings.durationSeconds) &&
    Number(settings.durationSeconds) >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
    Number(settings.durationSeconds) <= EFFECT_PROMPT_LIMITS.maxDurationSeconds &&
    Number.isInteger(settings.semanticLimit) &&
    Number(settings.semanticLimit) >= EFFECT_PROMPT_LIMITS.minSemanticDuplicateRate &&
    Number(settings.semanticLimit) <= EFFECT_PROMPT_LIMITS.maxSemanticDuplicateRate &&
    Number.isInteger(settings.visualLimit) &&
    Number(settings.visualLimit) >= EFFECT_PROMPT_LIMITS.minVisualOverlapRate &&
    Number(settings.visualLimit) <= EFFECT_PROMPT_LIMITS.maxVisualOverlapRate &&
    (settings.styleOverride === null ||
      (typeof settings.styleOverride === 'string' &&
        settings.styleOverride.trim().length > 0 &&
        settings.styleOverride.length <= EFFECT_PROMPT_LIMITS.maxStyleOverrideLength)) &&
    Object.keys(fragmentTypeWeights).length === EFFECT_PROMPT_FRAGMENT_TYPES.length &&
    EFFECT_PROMPT_FRAGMENT_TYPES.every(
      (fragmentType) =>
        Number.isInteger(fragmentTypeWeights[fragmentType]) &&
        Number(fragmentTypeWeights[fragmentType]) >= 0 &&
        Number(fragmentTypeWeights[fragmentType]) <= 100,
    ) &&
    EFFECT_PROMPT_FRAGMENT_TYPES.reduce(
      (sum, fragmentType) => sum + Number(fragmentTypeWeights[fragmentType]),
      0,
    ) === 100 &&
    Array.isArray(settings.sellingPointWeights) &&
    settings.sellingPointWeights.length <= EFFECT_PROMPT_LIMITS.maxSellingPointWeights &&
    settings.sellingPointWeights.every(
      (item) =>
        Boolean(record(item)) &&
        typeof item.sellingPoint === 'string' &&
        item.sellingPoint.trim().length > 0 &&
        item.sellingPoint.length <= 240 &&
        Number.isInteger(item.weight) &&
        item.weight >= 1 &&
        item.weight <= 100,
    ) &&
    new Set(settings.sellingPointWeights.map(({ sellingPoint }) => normalizedValue(sellingPoint)))
      .size === settings.sellingPointWeights.length &&
    (settings.sellingPointWeights.length === 0 ||
      settings.sellingPointWeights.reduce((sum, item) => sum + item.weight, 0) === 100) &&
    Array.isArray(settings.additionalDisabledElements) &&
    settings.additionalDisabledElements.length <=
      EFFECT_PROMPT_LIMITS.maxAdditionalDisabledElements &&
    settings.additionalDisabledElements.every(
      (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 240,
    ) &&
    new Set(settings.additionalDisabledElements.map(normalizedValue)).size ===
      settings.additionalDisabledElements.length
  );
};

const validMetrics = (value: unknown): value is EffectPromptMetrics => {
  const metrics = record(value);
  if (!metrics || Object.keys(metrics).length !== 13) return false;
  const integer = (key: keyof EffectPromptMetrics, minimum: number, maximum = Infinity) =>
    Number.isInteger(metrics[key]) &&
    Number(metrics[key]) >= minimum &&
    Number(metrics[key]) <= maximum;
  const rate = (key: 'semanticDuplicateRate' | 'visualOverlapRate') =>
    typeof metrics[key] === 'number' &&
    Number.isFinite(metrics[key]) &&
    metrics[key] >= 0 &&
    metrics[key] <= 100;
  const distribution = metrics.fragmentTypeDistribution;
  const coverage = record(metrics.sellingPointCoverage);
  const reasons = metrics.executionInvalidReasons;
  return (
    integer('targetCount', EFFECT_PROMPT_LIMITS.minCount, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('acceptedCount', 0, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('generatedCandidateCount', 0) &&
    integer('removedSemanticDuplicates', 0) &&
    integer('removedVisualDuplicates', 0) &&
    integer('removedDimensionConflicts', 0) &&
    rate('semanticDuplicateRate') &&
    rate('visualOverlapRate') &&
    integer('replenishmentRounds', 0, EFFECT_PROMPT_LIMITS.maxReplenishmentRounds) &&
    Array.isArray(distribution) &&
    distribution.length === EFFECT_PROMPT_FRAGMENT_TYPES.length &&
    EFFECT_PROMPT_FRAGMENT_TYPES.every(
      (fragmentType) =>
        distribution.filter((item) => record(item)?.fragmentType === fragmentType).length === 1,
    ) &&
    distribution.every((item) => {
      const entry = record(item);
      return Boolean(
        entry &&
        Object.keys(entry).length === 3 &&
        EFFECT_PROMPT_FRAGMENT_TYPES.includes(entry.fragmentType as EffectPromptFragmentType) &&
        Number.isInteger(entry.targetCount) &&
        Number(entry.targetCount) >= 0 &&
        Number.isInteger(entry.actualCount) &&
        Number(entry.actualCount) >= 0,
      );
    }) &&
    Boolean(
      coverage &&
      Object.keys(coverage).length === 3 &&
      ['required', 'covered', 'missing'].every(
        (key) =>
          Array.isArray(coverage[key]) &&
          (coverage[key] as unknown[]).every((item) => typeof item === 'string'),
      ),
    ) &&
    integer('removedExecutionInvalid', 0) &&
    Array.isArray(reasons) &&
    reasons.every((item) => {
      const entry = record(item);
      return Boolean(
        entry &&
        Object.keys(entry).length === 2 &&
        typeof entry.code === 'string' &&
        entry.code.trim().length > 0 &&
        entry.code.length <= 120 &&
        Number.isInteger(entry.count) &&
        Number(entry.count) > 0,
      );
    })
  );
};

export const recomputePromptQuality = (
  rawItems: EffectPromptItem[],
  rawSettings: EffectPromptBatchSettings,
  previous?: Partial<EffectPromptMetrics>,
): Pick<
  EffectPromptBatchResult,
  'schemaVersion' | 'settings' | 'items' | 'metrics' | 'qualityStatus'
> => {
  const settings = normalizeEffectPromptSettings(rawSettings);
  const items = rawItems.filter(isEffectPromptItem);
  let semanticViolations = 0;
  let visualViolations = 0;
  let dimensionConflicts = 0;
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (
        signature(items[left]!) === signature(items[right]!) ||
        trigramDice(items[left]!.content, items[right]!.content) >=
          EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD
      )
        semanticViolations += 1;
      if (visualOverlap(items[left]!, items[right]!) >= EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD)
        visualViolations += 1;
      if (dimensionDistance(items[left]!, items[right]!) < 3) dimensionConflicts += 1;
    }
  }
  const semanticDuplicateRate = promptPairViolationRate(semanticViolations, items.length);
  const visualOverlapRate = promptPairViolationRate(visualViolations, items.length);
  const targetCounts = effectPromptFragmentTypeTargetCounts(settings);
  const actualCounts = Object.fromEntries(
    EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => [
      fragmentType,
      items.filter((item) => item.fragmentType === fragmentType).length,
    ]),
  ) as Record<EffectPromptFragmentType, number>;
  const fragmentTypeDistribution = EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => ({
    fragmentType,
    targetCount: targetCounts[fragmentType],
    actualCount: actualCounts[fragmentType],
  }));
  const previousCoverage = previous?.sellingPointCoverage;
  const requiredSellingPoints = [
    ...new Map(
      (settings.sellingPointWeights.length
        ? settings.sellingPointWeights.map(({ sellingPoint }) => sellingPoint)
        : (previousCoverage?.required ?? [])
      ).map((sellingPoint) => [normalizedValue(sellingPoint), sellingPoint.trim()]),
    ).values(),
  ];
  const coveredSellingPoints = [
    ...new Map(
      items.map(({ dimensions }) => [
        normalizedValue(dimensions.sellingPoint),
        dimensions.sellingPoint.trim(),
      ]),
    ).values(),
  ];
  const coveredKeys = new Set(coveredSellingPoints.map(normalizedValue));
  const sellingPointCoverage = {
    required: requiredSellingPoints,
    covered: coveredSellingPoints,
    missing: requiredSellingPoints.filter(
      (sellingPoint) => !coveredKeys.has(normalizedValue(sellingPoint)),
    ),
  };
  const currentExecutionReasonCounts = new Map<string, number>();
  for (const prompt of items) {
    for (const code of effectPromptExecutionIssues(prompt))
      currentExecutionReasonCounts.set(code, (currentExecutionReasonCounts.get(code) ?? 0) + 1);
    if (prompt.targetDurationSeconds !== settings.durationSeconds)
      currentExecutionReasonCounts.set(
        'DURATION_MISMATCH',
        (currentExecutionReasonCounts.get('DURATION_MISMATCH') ?? 0) + 1,
      );
  }
  const executionReasonCounts = new Map<string, number>(
    (previous?.executionInvalidReasons ?? []).map(({ code, count }) => [code, count]),
  );
  for (const [code, count] of currentExecutionReasonCounts)
    executionReasonCounts.set(code, Math.max(executionReasonCounts.get(code) ?? 0, count));
  const executionInvalidReasons = [...executionReasonCounts]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([code, count]) => ({ code, count }));
  const metrics: EffectPromptMetrics = {
    targetCount: settings.count,
    acceptedCount: items.length,
    generatedCandidateCount: Math.max(
      previous?.generatedCandidateCount ?? items.length,
      items.length,
    ),
    removedSemanticDuplicates: Math.max(previous?.removedSemanticDuplicates ?? 0, 0),
    removedVisualDuplicates: Math.max(previous?.removedVisualDuplicates ?? 0, 0),
    removedDimensionConflicts: Math.max(
      previous?.removedDimensionConflicts ?? 0,
      dimensionConflicts,
    ),
    semanticDuplicateRate,
    visualOverlapRate,
    replenishmentRounds: Math.min(
      EFFECT_PROMPT_LIMITS.maxReplenishmentRounds,
      Math.max(previous?.replenishmentRounds ?? 0, 0),
    ),
    fragmentTypeDistribution,
    sellingPointCoverage,
    removedExecutionInvalid: Math.max(previous?.removedExecutionInvalid ?? 0, 0),
    executionInvalidReasons,
  };
  const fragmentTargetsMet = fragmentTypeDistribution.every(
    ({ targetCount, actualCount }) => targetCount === actualCount,
  );
  const qualityStatus =
    items.length === settings.count &&
    dimensionConflicts === 0 &&
    semanticDuplicateRate <= settings.semanticLimit &&
    visualOverlapRate <= settings.visualLimit &&
    fragmentTargetsMet &&
    sellingPointCoverage.missing.length === 0 &&
    currentExecutionReasonCounts.size === 0
      ? 'PASS'
      : 'NEEDS_REVIEW';
  return { schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION, settings, items, metrics, qualityStatus };
};

export const parseEffectPromptBatchResult = (value: unknown): EffectPromptBatchResult | null => {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION ||
    !isEffectPromptSettings(candidate.settings) ||
    !Array.isArray(candidate.items) ||
    candidate.items.length > EFFECT_PROMPT_LIMITS.maxCount ||
    !validMetrics(candidate.metrics) ||
    !['PASS', 'NEEDS_REVIEW'].includes(String(candidate.qualityStatus)) ||
    Object.keys(candidate).length !== 5
  )
    return null;
  const items = candidate.items.filter(isEffectPromptItem);
  if (
    items.length !== candidate.items.length ||
    new Set(items.map(({ id }) => id)).size !== items.length
  )
    return null;
  return recomputePromptQuality(
    items,
    candidate.settings,
    record(candidate.metrics) as Partial<EffectPromptMetrics> | undefined,
  );
};

export const mergeEffectPromptCompletionItems = (
  candidateItems: EffectPromptItem[],
  snapshot: EffectPromptInputSnapshot,
): EffectPromptItem[] => {
  if (snapshot.operation === 'BATCH_GENERATE') {
    const merged = new Map(candidateItems.map((item) => [item.id, item]));
    for (const item of snapshot.retainedManualItems) merged.set(item.id, item);
    return [...merged.values()].slice(0, snapshot.settings.count);
  }
  const target = snapshot.targetItem;
  const targetIndex = snapshot.targetItemIndex;
  if (!target || targetIndex === undefined) return [...snapshot.retainedManualItems];
  const retainedIds = new Set(snapshot.retainedManualItems.map(({ id }) => id));
  const replacement =
    candidateItems.find(({ id }) => id === target.id) ??
    candidateItems.find(({ id }) => !retainedIds.has(id));
  if (!replacement) return [...snapshot.retainedManualItems];
  const stableReplacement: EffectPromptItem = {
    ...replacement,
    id: target.id,
    code: target.code,
    origin: 'AI',
    manualEdited: false,
    createdAt: target.createdAt,
  };
  const merged = [...snapshot.retainedManualItems];
  merged.splice(Math.min(Math.max(targetIndex, 0), merged.length), 0, stableReplacement);
  return merged;
};
