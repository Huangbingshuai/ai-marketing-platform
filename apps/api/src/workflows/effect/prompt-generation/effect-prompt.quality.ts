import { createHash } from 'node:crypto';
import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptInsightBinding,
  EffectPromptInsightCoverage,
  EffectPromptInsightReference,
  EffectPromptInsightRole,
  EffectPromptMetrics,
  EffectPromptRenderProfile,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_INSIGHT_FIELDS,
  EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES,
  EFFECT_PROMPT_INSIGHT_ROLES,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  EFFECT_PROMPT_RENDER_CAPABILITY_KEYS,
  EFFECT_PROMPT_SCHEMA_VERSION,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
  effectPromptFragmentTypeTargetCounts,
  effectPromptTargetCount,
  migrateEffectPromptSettings,
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

const validInsightReference = (value: unknown): value is EffectPromptInsightReference => {
  const reference = record(value);
  return Boolean(
    reference &&
    Object.keys(reference).length >= 4 &&
    typeof reference.factId === 'string' &&
    reference.factId.length > 0 &&
    reference.factId.length <= 120 &&
    EFFECT_PROMPT_INSIGHT_FIELDS.includes(reference.field as never) &&
    typeof reference.value === 'string' &&
    reference.value.trim().length > 0 &&
    reference.value.length <= 500 &&
    typeof reference.valueHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(reference.valueHash),
  );
};

const validInsightBinding = (value: unknown): value is EffectPromptInsightBinding => {
  const binding = record(value);
  const role = binding?.role;
  return Boolean(
    binding &&
    Object.keys(binding).length === 5 &&
    validInsightReference(binding) &&
    EFFECT_PROMPT_INSIGHT_ROLES.includes(role as never),
  );
};

const bindingCompatible = (
  binding: EffectPromptInsightBinding,
  fragmentType: EffectPromptFragmentType,
): boolean =>
  EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES[binding.field]?.includes(fragmentType) ?? false;

const bindingRole = (field: EffectPromptInsightReference['field']): EffectPromptInsightRole => {
  if (field === 'TRUST_BACKING') return 'EVIDENCE';
  if (['CORE_SELLING_POINT', 'CORE_PAIN_POINT', 'MARKETING_GOAL', 'PRICE_RANGE'].includes(field))
    return 'PRIMARY';
  return 'CONTEXT';
};

const EXPRESSION_FIELD_PRIORITY: Record<
  EffectPromptFragmentType,
  EffectPromptInsightReference['field'][]
> = {
  HOOK: [
    'CORE_PAIN_POINT',
    'TARGET_AUDIENCE',
    'DECISION_DRIVER',
    'USAGE_SCENARIO',
    'PURCHASE_SCENARIO',
    'PRODUCT_CATEGORY',
    'EMOTIONAL_SCENARIO',
  ],
  PAIN: ['CORE_PAIN_POINT', 'TARGET_AUDIENCE', 'USAGE_SCENARIO', 'PURCHASE_SCENARIO'],
  PRODUCT_DISPLAY: [
    'PRODUCT_NAME',
    'VISUAL_FEATURES',
    'CORE_SPECIFICATION',
    'USAGE_SCENARIO',
    'CORE_SELLING_POINT',
    'PRODUCT_CATEGORY',
  ],
  SELLING_POINT_EXPLANATION: [
    'CORE_SELLING_POINT',
    'SECONDARY_SELLING_POINT',
    'VISUAL_FEATURES',
    'CORE_SPECIFICATION',
    'DECISION_DRIVER',
    'TRUST_BACKING',
    'PRODUCT_NAME',
  ],
  CTA: [
    'MARKETING_GOAL',
    'PRODUCT_NAME',
    'CORE_SELLING_POINT',
    'DECISION_DRIVER',
    'TARGET_AUDIENCE',
    'PRICE_RANGE',
    'PURCHASE_SCENARIO',
  ],
  OUTRO: ['PRODUCT_NAME', 'VISUAL_FEATURES', 'PRODUCT_CATEGORY', 'EMOTIONAL_SCENARIO'],
};

export const inferEffectPromptInsightBindings = (
  item: Pick<EffectPromptItem, 'content' | 'dimensions' | 'fragmentType'>,
  coverage?: EffectPromptInsightCoverage,
): EffectPromptInsightBinding[] => {
  if (!coverage) return [];
  const haystack = normalizedValue([item.content, ...Object.values(item.dimensions)].join(' '));
  const references = [...coverage.required, ...coverage.adaptive];
  const priority = EXPRESSION_FIELD_PRIORITY[item.fragmentType];
  return [...new Map(references.map((reference) => [reference.factId, reference])).values()]
    .filter(
      (reference) =>
        (EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES[reference.field]?.includes(item.fragmentType) ??
          false) &&
        haystack.includes(normalizedValue(reference.value)),
    )
    .sort((left, right) => {
      const leftIndex = priority.indexOf(left.field);
      const rightIndex = priority.indexOf(right.field);
      return (
        (leftIndex < 0 ? priority.length : leftIndex) -
          (rightIndex < 0 ? priority.length : rightIndex) || left.factId.localeCompare(right.factId)
      );
    })
    .slice(0, 3)
    .map((reference) => ({ ...reference, role: bindingRole(reference.field) }));
};

const META_LANGUAGE =
  /(?:^(?:痛点前置型|效果展示型|场景代入型|科普讲解型|对比测评型|开箱体验型)\s*[：:]|【?(?:叙事结构|场景变量|人物变量|卖点侧重|镜头语言|情绪基调|内容结构|创意核心|差异化设定)】?\s*[：=]|完成(?:单一)?卖点表达|围绕[^。；\n]+表达|产品特点自然出镜|根据(?:以上|要求|信息卡)|本条\s*prompt|视频生成方案|不(?:得|要)添加未经确认|禁止(?:夸大|未确认)|不得发明)/iu;
const ABSTRACT_PERSONA = /(?:目标人群|受众|消费者|用户群体|家庭决策者|爱好者|全国消费者|人群)/u;
const FULL_TIMELINE =
  /(?:\d+(?:\.\d+)?\s*[-—~至]\s*\d+(?:\.\d+)?\s*(?:秒|s)|第[一二三四五六\d]+镜|镜头[一二三四五六\d]+|分镜|时间轴|切换|切至|镜头转到|转场|硬切|叠化|闪白|蒙太奇)/iu;
const STRUCTURED_PHASE = /(?:前段|中段|后段)/gu;
const VISIBLE_ACTION =
  /(?:拿起|夹起|提起|拎起|托住|扶住|扶正|握住|放下|放入|放到|轻放|摆放|摆到|打开|关闭|取出|倒入|切开|撕开|按下|按压|涂抹|喷洒|擦拭|冲洗|折叠|展开|安装|装入|推拉|旋转|转动|倾斜|移动|移到|搅拌|加热|品尝|对比|揭开|翻转|挤出|穿戴|使用|离开|退出)/u;
const PLACEHOLDER_TEXT =
  /(?:待补充|以信息卡为准|自然出镜|相关细节|关键特点|适当|高级感|真实使用动作|当前产品名|指定卖点|当前场景|当前人物)/u;
const BAKED_TEXT =
  /(?:字幕|标题文字|屏幕文字|可读文字|价格贴纸|促销贴纸|二维码|购买按钮|销量角标|库存角标)/iu;
const AUDIO_OVERREACH = /(?:\bBGM\b|背景音乐|配乐|旁白|口播|人声解说|歌词|完整音效设计)/iu;
const ABSTRACT_VISUAL =
  /(?:工厂|生产线|实验室|检测设备|专家背书|原料加工|生产过程|制作过程|工艺流程|配方研发|技术原理)/u;
const PHYSICS_BREAK =
  /(?:凭空(?:出现|消失|移动|变形)|瞬间变(?:成|形)|自动悬浮|无接触(?:打开|移动|旋转)|穿透|违反重力)/u;
const REFERENCE_DEPENDENCY =
  /(?:精准还原|完全一致|一比一还原|包装文字清晰可读|标签文字清晰可读|(?:logo|商标|品牌标识)(?:与参考图)?完全一致)/iu;
const NEGATIVE_CLAUSE = /(?:不得|禁止|不生成|不出现|不要|避免)[^，,。；;!?！？]{2,80}/gu;
const CAMERA_MOVEMENTS = [
  /(?:推近|推进|靠近)/u,
  /(?:后拉|拉远)/u,
  /(?:跟拍|跟随|手持)/u,
  /环绕/u,
  /(?:横移|侧移)/u,
  /(?:移焦|焦点从.+(?:移到|转向))/u,
];
const CAMERA_CONTEXT =
  /(?:镜头|机位|特写|近景|中景|全景|微距|俯拍|俯视|仰拍|低机位|高机位|固定|肩后|手持|跟拍|环绕|横移|移焦|聚焦|焦点|景深|主观|推近|后拉|拉远)/u;

const overloadedAction = (content: string): boolean => {
  const actionCount = content.match(new RegExp(VISIBLE_ACTION.source, 'gu'))?.length ?? 0;
  const actionClauses = content
    .split(/[。；;!?！？]/u)
    .filter((clause) => VISIBLE_ACTION.test(clause)).length;
  return actionClauses >= 3 || actionCount > 5;
};

const cameraConflict = (content: string): boolean => {
  const cameraText = content
    .split(/[，,。；;!?！？]/u)
    .filter((chunk) => CAMERA_CONTEXT.test(chunk))
    .join(' ');
  const movementCount = CAMERA_MOVEMENTS.filter((pattern) => pattern.test(cameraText)).length;
  const movingFixedCamera = cameraText.includes('固定机位') && movementCount > 0;
  return movingFixedCamera || movementCount > 1;
};

export const effectPromptExecutionIssues = (item: EffectPromptItem): string[] => {
  const issues: string[] = [];
  const content = item.content.normalize('NFC');
  if (META_LANGUAGE.test(content)) issues.push('META_LANGUAGE');
  if (ABSTRACT_PERSONA.test(`${item.dimensions.persona} ${content}`))
    issues.push('ABSTRACT_PERSONA');
  // “首帧/结尾”是单片段的必要执行信息，不能仅因同时描述起止状态就误判为完整广告。
  // 多时间段、镜头编号和真实剪辑词仍由 FULL_TIMELINE 硬拒绝。
  if (FULL_TIMELINE.test(content) || new Set(content.match(STRUCTURED_PHASE) ?? []).size >= 2)
    issues.push('FULL_TIMELINE_NOT_FRAGMENT');
  if (!VISIBLE_ACTION.test(content)) issues.push('NO_VISIBLE_ACTION');
  if (PLACEHOLDER_TEXT.test(content)) issues.push('PLACEHOLDER_TEXT');
  if (overloadedAction(content)) issues.push('OVERLOADED_ACTION');
  if (cameraConflict(content)) issues.push('CAMERA_CONFLICT');
  if (item.insightBindings.length > 3) issues.push('FACT_OVERLOAD');
  if (BAKED_TEXT.test(content)) issues.push('BAKED_TEXT');
  if (AUDIO_OVERREACH.test(content)) issues.push('AUDIO_OVERREACH');
  if (ABSTRACT_VISUAL.test(content)) issues.push('ABSTRACT_VISUAL');
  if (PHYSICS_BREAK.test(content)) issues.push('PHYSICS_BREAK');
  if (REFERENCE_DEPENDENCY.test(content)) issues.push('REFERENCE_DEPENDENCY');
  if ((content.match(NEGATIVE_CLAUSE) ?? []).length >= 3) issues.push('NEGATIVE_TAIL_DUPLICATION');
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
    Array.isArray(item.insightBindings) &&
    item.insightBindings.length <= 16 &&
    item.insightBindings.every(validInsightBinding) &&
    new Set(item.insightBindings.map((binding) => binding.factId)).size ===
      item.insightBindings.length &&
    typeof item.manualEdited === 'boolean' &&
    validDateTime(item.createdAt) &&
    validDateTime(item.updatedAt) &&
    Object.keys(item).length === 12,
  );
};

export const isEffectPromptSettings = (value: unknown): value is EffectPromptBatchSettings => {
  const settings = record(value);
  if (!settings) return false;
  const fragmentConfigs = record(settings.fragmentConfigs);
  if (!fragmentConfigs) return false;
  const validFragmentConfigs =
    Object.keys(fragmentConfigs).length === EFFECT_PROMPT_FRAGMENT_TYPES.length &&
    EFFECT_PROMPT_FRAGMENT_TYPES.every((fragmentType) => {
      const config = record(fragmentConfigs[fragmentType]);
      return Boolean(
        config &&
        Object.keys(config).length === 2 &&
        Number.isInteger(config.count) &&
        Number(config.count) >= EFFECT_PROMPT_LIMITS.minFragmentCount &&
        Number(config.count) <= EFFECT_PROMPT_LIMITS.maxCount &&
        Number.isInteger(config.durationSeconds) &&
        Number(config.durationSeconds) >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
        Number(config.durationSeconds) <= EFFECT_PROMPT_LIMITS.maxDurationSeconds,
      );
    });
  const totalCount = EFFECT_PROMPT_FRAGMENT_TYPES.reduce((total, fragmentType) => {
    const config = record(fragmentConfigs[fragmentType]);
    return total + Number(config?.count ?? 0);
  }, 0);
  return (
    Object.keys(settings).length === 3 &&
    validFragmentConfigs &&
    totalCount >= EFFECT_PROMPT_LIMITS.minCount &&
    totalCount <= EFFECT_PROMPT_LIMITS.maxCount &&
    Number.isInteger(settings.semanticLimit) &&
    Number(settings.semanticLimit) >= EFFECT_PROMPT_LIMITS.minSemanticDuplicateRate &&
    Number(settings.semanticLimit) <= EFFECT_PROMPT_LIMITS.maxSemanticDuplicateRate &&
    Number.isInteger(settings.visualLimit) &&
    Number(settings.visualLimit) >= EFFECT_PROMPT_LIMITS.minVisualOverlapRate &&
    Number(settings.visualLimit) <= EFFECT_PROMPT_LIMITS.maxVisualOverlapRate
  );
};

const validMetrics = (value: unknown): value is EffectPromptMetrics => {
  const metrics = record(value);
  if (!metrics || Object.keys(metrics).length !== 15) return false;
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
  const insightCoverage = record(metrics.insightCoverage);
  const reasons = metrics.executionInvalidReasons;
  return (
    integer('targetCount', EFFECT_PROMPT_LIMITS.minCount, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('acceptedCount', 0, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('generatedCandidateCount', 0) &&
    integer('fallbackCount', 0, EFFECT_PROMPT_LIMITS.maxCount) &&
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
    Boolean(
      insightCoverage &&
      Object.keys(insightCoverage).length === 7 &&
      ['required', 'covered', 'missing', 'adaptive', 'deferred', 'appliedConstraints'].every(
        (key) =>
          Array.isArray(insightCoverage[key]) &&
          (insightCoverage[key] as unknown[]).every(validInsightReference),
      ) &&
      Array.isArray(insightCoverage.excluded) &&
      insightCoverage.excluded.every((item) => {
        const entry = record(item);
        const reason = entry?.reason;
        return Boolean(
          entry &&
          Object.keys(entry).length === 5 &&
          validInsightReference(entry) &&
          ['UNCERTAIN', 'EMPTY', 'UNSUPPORTED'].includes(String(reason)),
        );
      }),
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

export const defaultEffectPromptRenderProfile = (): EffectPromptRenderProfile => ({
  ratio: '9:16',
  resolution: '1080p',
  capabilityKey: 'SEEDANCE_2_0',
  sharedConstraints: {
    disabledElements: [],
    contentHash: createHash('sha256').update('').digest('hex'),
  },
});

export const isEffectPromptRenderProfile = (value: unknown): value is EffectPromptRenderProfile => {
  const profile = record(value);
  const constraints = record(profile?.sharedConstraints);
  if (!profile || !constraints) return false;
  const capabilityKey = profile.capabilityKey as EffectPromptRenderProfile['capabilityKey'];
  const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[capabilityKey];
  return Boolean(
    Object.keys(profile).length === 4 &&
    EFFECT_PROMPT_RENDER_CAPABILITY_KEYS.includes(capabilityKey) &&
    SEEDANCE_RATIOS.includes(profile.ratio as never) &&
    SEEDANCE_RESOLUTIONS.includes(profile.resolution as never) &&
    capability.ratios.includes(profile.ratio as never) &&
    capability.resolutions.includes(profile.resolution as never) &&
    Object.keys(constraints).length === 2 &&
    Array.isArray(constraints.disabledElements) &&
    constraints.disabledElements.length <= 100 &&
    constraints.disabledElements.every(
      (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500,
    ) &&
    new Set(constraints.disabledElements.map((item) => normalizedValue(String(item)))).size ===
      constraints.disabledElements.length &&
    typeof constraints.contentHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(constraints.contentHash),
  );
};

export const recomputePromptQuality = (
  rawItems: EffectPromptItem[],
  rawSettings: EffectPromptBatchSettings,
  previous?: Partial<EffectPromptMetrics>,
  renderProfile: EffectPromptRenderProfile = defaultEffectPromptRenderProfile(),
): Pick<
  EffectPromptBatchResult,
  'schemaVersion' | 'settings' | 'renderProfile' | 'items' | 'metrics' | 'qualityStatus'
> => {
  const settings = normalizeEffectPromptSettings(rawSettings);
  const items = rawItems.filter(isEffectPromptItem).map((item) => {
    const preserved = item.insightBindings.filter((binding) =>
      bindingCompatible(binding, item.fragmentType),
    );
    const inferred = inferEffectPromptInsightBindings(item, previous?.insightCoverage);
    return {
      ...item,
      insightBindings: [
        ...new Map(
          [...preserved, ...inferred].map((binding) => [binding.factId, binding]),
        ).values(),
      ].slice(0, 16),
    };
  });
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
  const requiredSellingPoints: string[] = [
    ...new Map(
      (previousCoverage?.required ?? []).map((sellingPoint) => [
        normalizedValue(sellingPoint),
        sellingPoint.trim(),
      ]),
    ).values(),
  ];
  const boundCoreSellingPoints = items.flatMap(({ insightBindings }) =>
    insightBindings.filter(({ field }) => field === 'CORE_SELLING_POINT').map(({ value }) => value),
  );
  const coveredSellingPoints = [
    ...new Map(
      boundCoreSellingPoints.map((sellingPoint) => [
        normalizedValue(sellingPoint),
        sellingPoint.trim(),
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
  const previousInsightCoverage = previous?.insightCoverage;
  const uniqueReferences = (values: EffectPromptInsightReference[] = []) => [
    ...new Map(values.map((reference) => [reference.factId, reference])).values(),
  ];
  const requiredInsightFacts = uniqueReferences(previousInsightCoverage?.required);
  const adaptiveInsightFacts = uniqueReferences(previousInsightCoverage?.adaptive);
  const boundFactIds = new Set(
    items.flatMap(({ insightBindings }) => insightBindings.map(({ factId }) => factId)),
  );
  const insightCoverage: EffectPromptInsightCoverage = {
    required: requiredInsightFacts,
    covered: requiredInsightFacts.filter(({ factId }) => boundFactIds.has(factId)),
    missing: requiredInsightFacts.filter(({ factId }) => !boundFactIds.has(factId)),
    adaptive: adaptiveInsightFacts,
    deferred: adaptiveInsightFacts.filter(({ factId }) => !boundFactIds.has(factId)),
    excluded: previousInsightCoverage?.excluded ?? [],
    appliedConstraints: uniqueReferences(previousInsightCoverage?.appliedConstraints),
  };
  const currentExecutionReasonCounts = new Map<string, number>();
  for (const prompt of items) {
    for (const code of effectPromptExecutionIssues(prompt))
      currentExecutionReasonCounts.set(code, (currentExecutionReasonCounts.get(code) ?? 0) + 1);
    if (
      prompt.targetDurationSeconds !== settings.fragmentConfigs[prompt.fragmentType].durationSeconds
    )
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
    targetCount: effectPromptTargetCount(settings),
    acceptedCount: items.length,
    generatedCandidateCount: Math.max(
      previous?.generatedCandidateCount ?? items.length,
      items.length,
    ),
    fallbackCount: Math.min(previous?.fallbackCount ?? 0, items.length),
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
    insightCoverage,
    removedExecutionInvalid: Math.max(previous?.removedExecutionInvalid ?? 0, 0),
    executionInvalidReasons,
  };
  const fragmentTargetsMet = fragmentTypeDistribution.every(
    ({ targetCount, actualCount }) => targetCount === actualCount,
  );
  const qualityStatus =
    items.length === effectPromptTargetCount(settings) &&
    dimensionConflicts === 0 &&
    semanticDuplicateRate <= settings.semanticLimit &&
    visualOverlapRate <= settings.visualLimit &&
    fragmentTargetsMet &&
    sellingPointCoverage.missing.length === 0 &&
    insightCoverage.missing.length === 0 &&
    currentExecutionReasonCounts.size === 0
      ? 'PASS'
      : 'NEEDS_REVIEW';
  return {
    schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
    settings,
    renderProfile,
    items,
    metrics,
    qualityStatus,
  };
};

export const parseEffectPromptBatchResult = (value: unknown): EffectPromptBatchResult | null => {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION ||
    !isEffectPromptSettings(candidate.settings) ||
    !isEffectPromptRenderProfile(candidate.renderProfile) ||
    !Array.isArray(candidate.items) ||
    candidate.items.length > EFFECT_PROMPT_LIMITS.maxCount ||
    !validMetrics(candidate.metrics) ||
    !['PASS', 'NEEDS_REVIEW'].includes(String(candidate.qualityStatus)) ||
    Object.keys(candidate).length !== 6
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
    candidate.renderProfile,
  );
};

export const parseLegacyV4EffectPromptBatchResultForRead = (
  value: unknown,
): EffectPromptBatchResult | null => {
  const candidate = record(value);
  if (!candidate || candidate.schemaVersion !== 4 || !Array.isArray(candidate.items)) return null;
  const settings = migrateEffectPromptSettings(candidate.settings, 4);
  const items = candidate.items.map((value) => {
    const item = record(value);
    if (!item || typeof item.fragmentType !== 'string') return null;
    const fragmentType = item.fragmentType as EffectPromptFragmentType;
    if (!EFFECT_PROMPT_FRAGMENT_TYPES.includes(fragmentType)) return null;
    const migrated = {
      ...item,
      targetDurationSeconds: settings.fragmentConfigs[fragmentType].durationSeconds,
    };
    return isEffectPromptItem(migrated) ? migrated : null;
  });
  if (
    items.some((item) => item === null) ||
    new Set(items.map((item) => item!.id)).size !== items.length
  )
    return null;
  const metrics = record(candidate.metrics);
  const coverage = record(metrics?.insightCoverage);
  const constraints = Array.isArray(coverage?.appliedConstraints)
    ? coverage.appliedConstraints.map(record).filter((item) => item !== null)
    : [];
  const rawRatio = constraints.find((item) => item?.field === 'ASPECT_RATIO')?.value;
  const ratio: EffectPromptRenderProfile['ratio'] = SEEDANCE_RATIOS.includes(rawRatio as never)
    ? (rawRatio as EffectPromptRenderProfile['ratio'])
    : '9:16';
  const disabledElements = [
    ...new Set(
      constraints
        .filter((item) => item?.field === 'DISABLED_ELEMENT' && typeof item.value === 'string')
        .map((item) => String(item!.value).trim())
        .filter(Boolean),
    ),
  ];
  const renderProfile: EffectPromptRenderProfile = {
    ratio,
    resolution: '1080p',
    capabilityKey: 'SEEDANCE_2_0',
    sharedConstraints: {
      disabledElements,
      contentHash: createHash('sha256').update(JSON.stringify(disabledElements)).digest('hex'),
    },
  };
  return recomputePromptQuality(
    items as EffectPromptItem[],
    settings,
    { ...(metrics as Partial<EffectPromptMetrics> | undefined), fallbackCount: 0 },
    renderProfile,
  );
};

export const mergeEffectPromptCompletionItems = (
  candidateItems: EffectPromptItem[],
  snapshot: EffectPromptInputSnapshot,
): EffectPromptItem[] => {
  if (snapshot.operation === 'BATCH_GENERATE') {
    const merged = new Map(candidateItems.map((item) => [item.id, item]));
    for (const item of snapshot.retainedManualItems) merged.set(item.id, item);
    return [...merged.values()].slice(0, effectPromptTargetCount(snapshot.settings));
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
    fragmentType: target.fragmentType,
    materialTags: [...target.materialTags],
    targetDurationSeconds: target.targetDurationSeconds,
    dimensions: snapshot.replacementDimensions ?? target.dimensions,
    manualEdited: false,
    createdAt: target.createdAt,
  };
  const merged = [...snapshot.retainedManualItems];
  merged.splice(Math.min(Math.max(targetIndex, 0), merged.length), 0, stableReplacement);
  return merged;
};
