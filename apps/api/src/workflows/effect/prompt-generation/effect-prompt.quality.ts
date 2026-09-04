import { createHash } from 'node:crypto';
import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptClassificationStatus,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptInsightBinding,
  EffectPromptInsightCoverage,
  EffectPromptInsightReference,
  EffectPromptInsightRole,
  EffectPromptMetrics,
  EffectPromptRenderProfile,
  EffectPromptSemanticEvaluation,
  EffectPromptSharedPrompt,
  EffectPromptSharedPromptSection,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_INSIGHT_FIELDS,
  EFFECT_PROMPT_CLASSIFICATION_STATUSES,
  EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES,
  EFFECT_PROMPT_INSIGHT_ROLES,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  EFFECT_PROMPT_RENDER_CAPABILITY_KEYS,
  EFFECT_PROMPT_SEMANTIC_EVALUATION_STATUSES,
  EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
  effectPromptTargetCount,
  normalizeEffectPromptSettings,
  normalizeEffectPromptFragmentType,
  normalizeEffectPromptFragmentTypes,
} from '@ai-marketing/contracts';
import type { EffectPromptInputSnapshot } from './effect-prompt.types';

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
  creativeCore: 160,
  content: 12_000,
} as const;
const dimensionTextLimits: Record<keyof EffectPromptDimensions, number> = {
  narrative: 120,
  scene: 120,
  persona: 160,
  productRelation: 240,
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

const validInsightCoverage = (value: unknown): value is EffectPromptInsightCoverage => {
  const coverage = record(value);
  if (!coverage || Object.keys(coverage).length !== 7) return false;
  const references = (key: string) =>
    Array.isArray(coverage[key]) && coverage[key].every(validInsightReference);
  return Boolean(
    references('required') &&
    references('covered') &&
    references('missing') &&
    references('adaptive') &&
    references('deferred') &&
    references('appliedConstraints') &&
    Array.isArray(coverage.excluded) &&
    coverage.excluded.every((item) => {
      const excluded = record(item);
      const reason = excluded?.reason;
      return Boolean(
        excluded &&
        validInsightReference(excluded) &&
        ['UNCERTAIN', 'EMPTY', 'UNSUPPORTED'].includes(String(reason)),
      );
    }),
  );
};

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
  PRODUCT_DISPLAY: [
    'PRODUCT_NAME',
    'VISUAL_FEATURES',
    'CORE_SPECIFICATION',
    'USAGE_SCENARIO',
    'CORE_SELLING_POINT',
    'PRODUCT_CATEGORY',
  ],
  EFFECT: [
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
    'VISUAL_FEATURES',
    'PRODUCT_CATEGORY',
    'EMOTIONAL_SCENARIO',
  ],
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
  /(?:拿起|夹起|提起|拎起|托住|扶住|扶正|握住|放下|放入|放到|轻放|摆放|摆到|打开|关闭|取出|倒入|切开|撕开|按下|按压|涂抹|喷洒|擦拭|冲洗|折叠|展开|安装|装入|推拉|旋转|转动|倾斜|移动|移到|移开|平移|抬升|扫过|铺撒|夹取|抽出|揭开|摆正|轻推|缓推|调整|寻找|翻找|翻动|对照|比对|注视|凝视|扫视|变焦|收焦|尝试|停下|停住|搅拌|加热|品尝|对比|翻转|挤出|穿戴|使用|离开|退出|触碰|落到|恢复)/u;
const PLACEHOLDER_TEXT =
  /(?:待补充|以信息卡为准|自然出镜|相关细节|关键特点|适当|高级感|真实使用动作|当前产品名|指定卖点|当前场景|当前人物)/u;
const BAKED_TEXT =
  /(?:字幕|标题文字|屏幕文字|可读文字|价格贴纸|促销贴纸|二维码|购买按钮|销量角标|库存角标)/iu;
const AUDIO_OVERREACH = /(?:\bBGM\b|背景音乐|配乐|旁白|口播|人声解说|歌词|完整音效设计)/iu;
const RENDER_METADATA =
  /(?:(?:画幅\s*)?(?:16:9|4:3|1:1|3:4|9:16|21:9|9:21)(?:竖屏|横屏)?|(?:分辨率\s*)?(?:480|720|1080)[pP]|(?:时长\s*)?\d+(?:\.\d+)?秒)/gu;
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
const HOOK_RESOLVED =
  /(?:答案(?:出现|揭晓)|揭晓(?:答案|原因)|原来是|问题(?:被|已)?解决|成功(?:打开|完成)|恢复正常|效果立刻出现)/u;
const PRODUCT_EFFECT_LEAK =
  /(?:使用后|效果对比|前后对比|问题解决|明显改善|立刻见效|满意(?:微笑|点头)|证明(?:效果|功效))/u;
const PACKAGED_STATE = /(?:真空袋装|袋装|包装|袋身)/u;
const UNPACKAGED_END_STATE = /(?:最终|结束时|随后|转眼).{0,80}(?:蒸笼|盘中|碗中|切片|散装|裸露)/u;
const PACKAGE_TRANSITION_ACTION = /(?:打开|拆开|撕开|取出|倒出|拿出)/u;
const SAFE_AREA = /(?:留白|安全区|干净空间|简洁背景|无遮挡空间|空白墙面|空白区域|干净无遮挡)/u;
const ABSTRACT_SELLING_POINT = /(?:工艺|配方|技术|理念|品质|匠心|专业|口感|香味|风味|酒香|回甘)/u;
const ATTRIBUTE_SELLING_POINT = /(?:外观|颜色|材质|纹理|切面|尺寸|轻量|便携|设计)/u;
const ATTRIBUTE_CUE = /(?:外观|表面|轮廓|颜色|材质|纹理|切面|接口|细节|受光)/u;

/**
 * These checks describe refinement opportunities rather than an unusable or unsafe prompt.
 * Unknown/new issue codes deliberately remain hard until they are explicitly reviewed here.
 */
export const EFFECT_PROMPT_SOFT_QUALITY_ISSUE_CODES = [
  'PROMPT_LENGTH_MISMATCH',
  'MISSING_LIGHTING_OR_PACING',
  'MISSING_CAMERA_EXECUTION',
  'ABSTRACT_PERSONA',
  'NEGATIVE_TAIL_DUPLICATION',
] as const;

const softQualityIssueCodes = new Set<string>(EFFECT_PROMPT_SOFT_QUALITY_ISSUE_CODES);

export const effectPromptHardExecutionIssues = (issues: readonly string[]): string[] =>
  issues.filter((code) => !softQualityIssueCodes.has(code));

export const effectPromptSoftQualityWarnings = (issues: readonly string[]): string[] =>
  issues.filter((code) => softQualityIssueCodes.has(code));

const overloadedAction = (content: string): boolean => {
  const actionCount = content.match(new RegExp(VISIBLE_ACTION.source, 'gu'))?.length ?? 0;
  const sequenceCount = content.match(/(?:随后|接着|然后|再(?:次)?|最后)/gu)?.length ?? 0;
  return sequenceCount >= 2 || actionCount > 12;
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

const promptLengthBounds = (durationSeconds: number): readonly [number, number] => {
  if (durationSeconds <= 5) return [80, 150];
  if (durationSeconds <= 8) return [90, 200];
  return [100, 260];
};

export const effectPromptExecutionIssues = (item: EffectPromptItem): string[] => {
  const issues: string[] = [];
  const content = item.content.normalize('NFC');
  const [minimumLength, maximumLength] = promptLengthBounds(item.targetDurationSeconds);
  const creativeContent = content.replace(RENDER_METADATA, '').replace(/[，,。；;\s]+$/gu, '');
  if (creativeContent.length < minimumLength || creativeContent.length > maximumLength)
    issues.push('PROMPT_LENGTH_MISMATCH');
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
  if (item.fragmentType === 'HOOK' && HOOK_RESOLVED.test(content)) issues.push('HOOK_RESOLVED');
  if (item.fragmentType === 'PRODUCT_DISPLAY') {
    const productName = item.insightBindings.find(
      (binding) => binding.field === 'PRODUCT_NAME',
    )?.value;
    if (productName && !content.slice(0, 80).includes(productName))
      issues.push('PRODUCT_NOT_FIRST_FRAME');
    if (PRODUCT_EFFECT_LEAK.test(content)) issues.push('PRODUCT_ROLE_OVERLOAD');
    if (
      PACKAGED_STATE.test(content) &&
      UNPACKAGED_END_STATE.test(content) &&
      !PACKAGE_TRANSITION_ACTION.test(content)
    )
      issues.push('PHYSICS_BREAK');
  }
  if (
    item.fragmentType === 'EFFECT' &&
    !ABSTRACT_SELLING_POINT.test(item.dimensions.productRelation) &&
    ATTRIBUTE_SELLING_POINT.test(item.dimensions.productRelation) &&
    !ATTRIBUTE_CUE.test(content)
  )
    issues.push('EVIDENCE_MODE_MISMATCH');
  if (item.fragmentType === 'CTA' && !SAFE_AREA.test(content)) issues.push('CTA_NO_SAFE_AREA');
  return issues;
};

const exactPromptContent = (item: EffectPromptItem): string => semanticText(item.content);

export const effectPromptExactDuplicatePairs = (items: readonly EffectPromptItem[]): number => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const content = exactPromptContent(item);
    if (content) counts.set(content, (counts.get(content) ?? 0) + 1);
  }
  return [...counts.values()].reduce((pairs, count) => pairs + (count * (count - 1)) / 2, 0);
};

const validBaseItem = (item: Record<string, unknown>): boolean =>
  Boolean(
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    item.id.length <= itemTextLimits.id &&
    typeof item.code === 'string' &&
    item.code.trim().length > 0 &&
    item.code.length <= itemTextLimits.code &&
    (item.origin === 'AI' || item.origin === 'MANUAL') &&
    typeof item.fragmentType === 'string' &&
    EFFECT_PROMPT_FRAGMENT_TYPES.includes(item.fragmentType as EffectPromptFragmentType) &&
    Number.isInteger(item.targetDurationSeconds) &&
    Number(item.targetDurationSeconds) >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
    Number(item.targetDurationSeconds) <= EFFECT_PROMPT_LIMITS.maxDurationSeconds &&
    typeof item.creativeCore === 'string' &&
    item.creativeCore.trim().length > 0 &&
    item.creativeCore.length <= itemTextLimits.creativeCore &&
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
    validDateTime(item.updatedAt),
  );

export const isEffectPromptItem = (value: unknown): value is EffectPromptItem => {
  const item = record(value);
  const compatiblePurposes = item?.compatiblePurposes;
  return Boolean(
    item &&
    validBaseItem(item) &&
    validDimensions(item.dimensions) &&
    EFFECT_PROMPT_FRAGMENT_TYPES.includes(item.primaryPurpose as EffectPromptFragmentType) &&
    item.fragmentType === item.primaryPurpose &&
    Array.isArray(compatiblePurposes) &&
    compatiblePurposes.length >= 1 &&
    compatiblePurposes.length <= EFFECT_PROMPT_FRAGMENT_TYPES.length &&
    compatiblePurposes.every((purpose) =>
      EFFECT_PROMPT_FRAGMENT_TYPES.includes(purpose as EffectPromptFragmentType),
    ) &&
    new Set(compatiblePurposes).size === compatiblePurposes.length &&
    compatiblePurposes.includes(item.primaryPurpose) &&
    EFFECT_PROMPT_CLASSIFICATION_STATUSES.includes(
      item.classificationStatus as EffectPromptClassificationStatus,
    ) &&
    Number.isInteger(item.productRelevance) &&
    Number(item.productRelevance) >= 0 &&
    Number(item.productRelevance) <= 100 &&
    (item.reviewIssues === undefined ||
      (Array.isArray(item.reviewIssues) &&
        item.reviewIssues.length <= 10 &&
        item.reviewIssues.every(
          (issue) => typeof issue === 'string' && issue.trim().length > 0 && issue.length <= 120,
        ) &&
        new Set(item.reviewIssues).size === item.reviewIssues.length)) &&
    (item.classificationStatus !== 'NEEDS_REVISION' ||
      (Array.isArray(item.reviewIssues) && item.reviewIssues.length > 0)) &&
    (item.classificationStatus === 'NEEDS_REVISION' ||
      item.reviewIssues === undefined ||
      item.reviewIssues.length === 0) &&
    [16, 17].includes(Object.keys(item).length),
  );
};

const withCurrentItemCompatibility = (value: unknown): unknown => {
  const item = record(value);
  if (!item) return value;
  const withoutLegacyTags = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== 'materialTags'),
  );
  const primaryPurpose = normalizeEffectPromptFragmentType(
    withoutLegacyTags.primaryPurpose ?? withoutLegacyTags.fragmentType,
  );
  const compatiblePurposes = normalizeEffectPromptFragmentTypes(
    withoutLegacyTags.compatiblePurposes,
  );
  const current = primaryPurpose
    ? {
        ...withoutLegacyTags,
        fragmentType: primaryPurpose,
        primaryPurpose,
        compatiblePurposes: [
          primaryPurpose,
          ...compatiblePurposes.filter((purpose) => purpose !== primaryPurpose),
        ],
      }
    : withoutLegacyTags;
  const withReviewIssues =
    current.reviewIssues === undefined ? { ...current, reviewIssues: [] } : current;
  if (withReviewIssues.creativeCore !== undefined) return withReviewIssues;
  const dimensions = record(withReviewIssues.dimensions);
  const narrative = typeof dimensions?.narrative === 'string' ? dimensions.narrative.trim() : '';
  return narrative ? { ...withReviewIssues, creativeCore: narrative } : withReviewIssues;
};

const withCurrentMetricsCompatibility = (value: unknown): unknown => {
  const metrics = record(value);
  if (!metrics || !Array.isArray(metrics.purposeDistribution)) return value;
  const totals = new Map(
    EFFECT_PROMPT_FRAGMENT_TYPES.map((purpose) => [
      purpose,
      { primaryCount: 0, compatibleCount: 0 },
    ]),
  );
  for (const value of metrics.purposeDistribution) {
    const entry = record(value);
    const purpose = normalizeEffectPromptFragmentType(entry?.purpose);
    if (!entry || !purpose) continue;
    const total = totals.get(purpose)!;
    if (Number.isInteger(entry.primaryCount)) total.primaryCount += Number(entry.primaryCount);
    if (Number.isInteger(entry.compatibleCount))
      total.compatibleCount += Number(entry.compatibleCount);
  }
  return {
    ...metrics,
    purposeDistribution: EFFECT_PROMPT_FRAGMENT_TYPES.map((purpose) => ({
      purpose,
      ...totals.get(purpose)!,
    })),
  };
};

export const isEffectPromptSettings = (value: unknown): value is EffectPromptBatchSettings => {
  const settings = record(value);
  return Boolean(
    settings &&
    Object.keys(settings).length === 2 &&
    Number.isInteger(settings.targetCount) &&
    Number(settings.targetCount) >= EFFECT_PROMPT_LIMITS.minCount &&
    Number(settings.targetCount) <= EFFECT_PROMPT_LIMITS.maxCount &&
    Number.isInteger(settings.defaultDurationSeconds) &&
    Number(settings.defaultDurationSeconds) >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
    Number(settings.defaultDurationSeconds) <= EFFECT_PROMPT_LIMITS.maxDurationSeconds,
  );
};

const validIssueCounts = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every((item) => {
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
  });

const validSemanticEvaluation = (value: unknown): value is EffectPromptSemanticEvaluation => {
  const evaluation = record(value);
  if (!evaluation || Object.keys(evaluation).length !== 5) return false;
  const nullableCount = (key: 'duplicateGroupCount' | 'duplicateCount') =>
    evaluation[key] === null ||
    (Number.isInteger(evaluation[key]) &&
      Number(evaluation[key]) >= 0 &&
      Number(evaluation[key]) <= EFFECT_PROMPT_LIMITS.maxCandidateCount);
  const nullableRate =
    evaluation.duplicateRate === null ||
    (typeof evaluation.duplicateRate === 'number' &&
      Number.isFinite(evaluation.duplicateRate) &&
      evaluation.duplicateRate >= 0 &&
      evaluation.duplicateRate <= 100);
  const status = evaluation.status;
  const verifiedValues =
    evaluation.duplicateGroupCount !== null &&
    evaluation.duplicateCount !== null &&
    evaluation.duplicateRate !== null;
  return Boolean(
    EFFECT_PROMPT_SEMANTIC_EVALUATION_STATUSES.includes(status as never) &&
    Number.isInteger(evaluation.evaluatedCount) &&
    Number(evaluation.evaluatedCount) >= 0 &&
    Number(evaluation.evaluatedCount) <= EFFECT_PROMPT_LIMITS.maxCandidateCount &&
    nullableCount('duplicateGroupCount') &&
    nullableCount('duplicateCount') &&
    nullableRate &&
    (status === 'VERIFIED' ? verifiedValues : !verifiedValues),
  );
};

export const pendingEffectPromptSemanticEvaluation = (): EffectPromptSemanticEvaluation => ({
  status: 'PENDING',
  evaluatedCount: 0,
  duplicateGroupCount: null,
  duplicateCount: null,
  duplicateRate: null,
});

const validMetrics = (value: unknown): value is EffectPromptMetrics => {
  const metrics = record(value);
  if (!metrics || ![12, 13].includes(Object.keys(metrics).length)) return false;
  const integer = (key: keyof EffectPromptMetrics, minimum: number, maximum = Infinity) =>
    Number.isInteger(metrics[key]) &&
    Number(metrics[key]) >= minimum &&
    Number(metrics[key]) <= maximum;
  const distribution = metrics.purposeDistribution;
  const scores = record(metrics.averageScores);
  return Boolean(
    integer('targetCount', EFFECT_PROMPT_LIMITS.minCount, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer(
      'candidateTargetCount',
      EFFECT_PROMPT_LIMITS.minCount,
      EFFECT_PROMPT_LIMITS.maxCandidateCount,
    ) &&
    integer('generatedCandidateCount', 0) &&
    integer('acceptedCount', 0, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('rejectedCount', 0) &&
    integer('replenishmentRounds', 0, EFFECT_PROMPT_LIMITS.maxReplenishmentRounds) &&
    integer('exactDuplicateCount', 0) &&
    (metrics.semanticEvaluation === undefined ||
      validSemanticEvaluation(metrics.semanticEvaluation)) &&
    Array.isArray(distribution) &&
    distribution.length === EFFECT_PROMPT_FRAGMENT_TYPES.length &&
    EFFECT_PROMPT_FRAGMENT_TYPES.every(
      (purpose) => distribution.filter((item) => record(item)?.purpose === purpose).length === 1,
    ) &&
    distribution.every((item) => {
      const entry = record(item);
      return Boolean(
        entry &&
        Object.keys(entry).length === 3 &&
        EFFECT_PROMPT_FRAGMENT_TYPES.includes(entry.purpose as EffectPromptFragmentType) &&
        Number.isInteger(entry.primaryCount) &&
        Number(entry.primaryCount) >= 0 &&
        Number.isInteger(entry.compatibleCount) &&
        Number(entry.compatibleCount) >= 0,
      );
    }) &&
    scores &&
    Object.keys(scores).length === 5 &&
    [
      'productRelevance',
      'creativeCoherence',
      'visualExecutability',
      'commercialUsefulness',
      'visualClarity',
    ].every(
      (key) =>
        typeof scores[key] === 'number' &&
        Number.isFinite(scores[key]) &&
        Number(scores[key]) >= 0 &&
        Number(scores[key]) <= 100,
    ) &&
    validIssueCounts(metrics.hardIssueCounts) &&
    validIssueCounts(metrics.warningCounts) &&
    validInsightCoverage(metrics.insightCoverage),
  );
};

export const defaultEffectPromptRenderProfile = (): EffectPromptRenderProfile => ({
  ratio: '9:16',
  resolution: '720p',
  capabilityKey: 'SEEDANCE_2_0',
  sharedConstraints: {
    disabledElements: [],
    contentHash: sha256Json([]),
  },
});

export const compileEffectPromptSharedConstraintPrompt = (disabledElements: string[]): string => {
  const normalized = normalizedDisabledElements(disabledElements);
  return normalized.length ? `画面中不得出现以下内容：${normalized.join('；')}。` : '';
};

const normalizedDisabledElements = (values: string[]): string[] => {
  const unique = new Map<string, string>();
  for (const value of values) {
    const cleaned = value
      .trim()
      .replace(/\s+/gu, ' ')
      .replace(/[。；;，,]+$/gu, '')
      .trim();
    if (!cleaned) continue;
    const key = cleaned.normalize('NFKC').toLocaleLowerCase('zh-CN');
    if (!unique.has(key)) unique.set(key, cleaned);
  }
  return [...unique.values()];
};

const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex');
const sha256Json = (value: unknown): string => sha256Text(JSON.stringify(value));

export type EffectPromptSemanticAudit = {
  schemaVersion: 1;
  similarityThreshold: number;
  evaluatedItems: Array<{ itemId: string; contentHash: string }>;
  duplicatePairs: Array<{ leftItemId: string; rightItemId: string }>;
  contentFingerprint: string;
};

const semanticContentHash = (content: string): string =>
  sha256Text(content.normalize('NFKC').trim());

export const parseEffectPromptSemanticAudit = (
  value: unknown,
  items: EffectPromptItem[],
  allowItemSubset = false,
): EffectPromptSemanticAudit | null => {
  const audit = record(value);
  if (!audit || Object.keys(audit).length !== 5) return null;
  const evaluatedItems = Array.isArray(audit.evaluatedItems) ? audit.evaluatedItems : [];
  const duplicatePairs = Array.isArray(audit.duplicatePairs) ? audit.duplicatePairs : [];
  if (
    audit.schemaVersion !== 1 ||
    audit.similarityThreshold !== EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD ||
    evaluatedItems.length > EFFECT_PROMPT_LIMITS.maxCount ||
    duplicatePairs.length > EFFECT_PROMPT_LIMITS.maxCount * EFFECT_PROMPT_LIMITS.maxCount ||
    typeof audit.contentFingerprint !== 'string'
  )
    return null;
  const normalizedItems: EffectPromptSemanticAudit['evaluatedItems'] = [];
  const evaluatedIds = new Set<string>();
  for (const rawItem of evaluatedItems) {
    const item = record(rawItem);
    if (
      !item ||
      Object.keys(item).length !== 2 ||
      typeof item.itemId !== 'string' ||
      !/^[a-f0-9-]{36}$/iu.test(item.itemId) ||
      typeof item.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.contentHash) ||
      evaluatedIds.has(item.itemId)
    )
      return null;
    evaluatedIds.add(item.itemId);
    normalizedItems.push({ itemId: item.itemId, contentHash: item.contentHash });
  }
  normalizedItems.sort((left, right) => left.itemId.localeCompare(right.itemId, 'en-US'));
  if (sha256Json(normalizedItems) !== audit.contentFingerprint) return null;
  const currentById = new Map(items.map((item) => [item.id, item]));
  const auditedHashById = new Map(
    normalizedItems.map(({ itemId, contentHash }) => [itemId, contentHash]),
  );
  if (
    currentById.size !== items.length ||
    (!allowItemSubset && normalizedItems.length !== items.length) ||
    items.some(({ id, content }) => auditedHashById.get(id) !== semanticContentHash(content))
  )
    return null;
  const normalizedPairs: EffectPromptSemanticAudit['duplicatePairs'] = [];
  const pairKeys = new Set<string>();
  for (const rawPair of duplicatePairs) {
    const pair = record(rawPair);
    if (
      !pair ||
      Object.keys(pair).length !== 2 ||
      typeof pair.leftItemId !== 'string' ||
      typeof pair.rightItemId !== 'string' ||
      pair.leftItemId === pair.rightItemId ||
      !evaluatedIds.has(pair.leftItemId) ||
      !evaluatedIds.has(pair.rightItemId)
    )
      return null;
    const orderedItemIds = [pair.leftItemId, pair.rightItemId].sort((left, right) =>
      left.localeCompare(right, 'en-US'),
    );
    const leftItemId = orderedItemIds[0]!;
    const rightItemId = orderedItemIds[1]!;
    const key = `${leftItemId}:${rightItemId}`;
    if (pairKeys.has(key)) return null;
    pairKeys.add(key);
    normalizedPairs.push({ leftItemId, rightItemId });
  }
  return {
    schemaVersion: 1,
    similarityThreshold: EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD,
    evaluatedItems: normalizedItems,
    duplicatePairs: normalizedPairs,
    contentFingerprint: audit.contentFingerprint,
  };
};

export const semanticEvaluationAfterDeletion = (
  items: EffectPromptItem[],
  audit: EffectPromptSemanticAudit,
): EffectPromptSemanticEvaluation => {
  const remainingIds = new Set(items.map(({ id }) => id));
  const auditedHashes = new Map(
    audit.evaluatedItems.map((item) => [item.itemId, item.contentHash]),
  );
  if (items.some((item) => auditedHashes.get(item.id) !== semanticContentHash(item.content)))
    return pendingEffectPromptSemanticEvaluation();
  const parent = new Map([...remainingIds].map((id) => [id, id]));
  const find = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current)!;
    while (parent.get(id) !== id) {
      const next = parent.get(id)!;
      parent.set(id, current);
      id = next;
    }
    return current;
  };
  for (const { leftItemId, rightItemId } of audit.duplicatePairs) {
    if (!remainingIds.has(leftItemId) || !remainingIds.has(rightItemId)) continue;
    const leftRoot = find(leftItemId);
    const rightRoot = find(rightItemId);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  }
  const componentSizes = new Map<string, number>();
  for (const id of remainingIds) {
    const root = find(id);
    componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
  }
  const duplicateGroups = [...componentSizes.values()].filter((size) => size > 1);
  const duplicateCount = duplicateGroups.reduce((sum, size) => sum + size - 1, 0);
  return {
    status: 'VERIFIED',
    evaluatedCount: items.length,
    duplicateGroupCount: duplicateGroups.length,
    duplicateCount,
    duplicateRate: items.length ? Math.round((duplicateCount / items.length) * 10_000) / 100 : 0,
  };
};

export const compileEffectPromptSharedPrompt = (
  disabledElements: string[],
  additionalContent = '',
  existingSections: EffectPromptSharedPromptSection[] = [],
): EffectPromptSharedPrompt => {
  const disabled = normalizedDisabledElements(disabledElements);
  const additional = additionalContent.trim();
  const knownKeys = new Set(['DISABLED_ELEMENTS', 'USER_ADDITIONAL']);
  const sections: EffectPromptSharedPromptSection[] = [
    {
      key: 'DISABLED_ELEMENTS',
      title: '禁用元素',
      source: 'SYSTEM',
      content: compileEffectPromptSharedConstraintPrompt(disabled),
      editable: false,
      sourceHash: sha256Json(disabled),
    },
    ...existingSections.filter(({ key }) => !knownKeys.has(key)),
    {
      key: 'USER_ADDITIONAL',
      title: '补充共用内容',
      source: 'USER',
      content: additional,
      editable: true,
      sourceHash: sha256Text(additional),
    },
  ];
  const compiledContent = sections
    .map(({ content }) => content.trim())
    .filter(Boolean)
    .join('\n');
  return {
    sections,
    compiledContent,
    contentHash: sha256Text(compiledContent),
  };
};

export const effectPromptAdditionalSharedContent = (
  sharedPrompt: EffectPromptSharedPrompt | undefined,
): string =>
  sharedPrompt?.sections.find(({ key }) => key === 'USER_ADDITIONAL')?.content.trim() ?? '';

export const isEffectPromptSharedPrompt = (
  value: unknown,
  disabledElements: string[],
): value is EffectPromptSharedPrompt => {
  const prompt = record(value);
  if (!prompt || !Array.isArray(prompt.sections)) return false;
  const sections = prompt.sections.map(record);
  if (
    Object.keys(prompt).length !== 3 ||
    sections.length < 1 ||
    sections.length > 20 ||
    sections.some((section) => !section || Object.keys(section).length !== 6)
  )
    return false;
  const typed = sections as Array<Record<string, unknown>>;
  if (
    typed.some(
      (section) =>
        typeof section.key !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,63}$/u.test(section.key) ||
        typeof section.title !== 'string' ||
        section.title.trim().length === 0 ||
        section.title.length > 120 ||
        !['SYSTEM', 'USER'].includes(String(section.source)) ||
        typeof section.content !== 'string' ||
        section.content.length > 30_000 ||
        section.content !== section.content.trim() ||
        typeof section.editable !== 'boolean' ||
        typeof section.sourceHash !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(section.sourceHash),
    ) ||
    new Set(typed.map(({ key }) => key)).size !== typed.length
  )
    return false;
  const disabled = typed.find(({ key }) => key === 'DISABLED_ELEMENTS');
  const additional = typed.find(({ key }) => key === 'USER_ADDITIONAL');
  const normalizedDisabled = normalizedDisabledElements(disabledElements);
  if (
    !disabled ||
    disabled.source !== 'SYSTEM' ||
    disabled.editable !== false ||
    disabled.content !== compileEffectPromptSharedConstraintPrompt(normalizedDisabled) ||
    disabled.sourceHash !== sha256Json(normalizedDisabled) ||
    !additional ||
    additional.source !== 'USER' ||
    additional.editable !== true ||
    additional.sourceHash !== sha256Text(String(additional.content))
  )
    return false;
  const compiledContent = typed
    .map(({ content }) => String(content))
    .filter(Boolean)
    .join('\n');
  return (
    typeof prompt.compiledContent === 'string' &&
    prompt.compiledContent === compiledContent &&
    prompt.compiledContent.length <= 60_000 &&
    typeof prompt.contentHash === 'string' &&
    prompt.contentHash === sha256Text(compiledContent)
  );
};

export const isEffectPromptRenderProfile = (value: unknown): value is EffectPromptRenderProfile => {
  const profile = record(value);
  const constraints = record(profile?.sharedConstraints);
  if (!profile || !constraints) return false;
  const capabilityKey = profile.capabilityKey as EffectPromptRenderProfile['capabilityKey'];
  const capability = EFFECT_PROMPT_RENDER_CAPABILITIES[capabilityKey];
  const disabledElements = Array.isArray(constraints.disabledElements)
    ? constraints.disabledElements
    : [];
  return Boolean(
    Object.keys(profile).length === 4 &&
    EFFECT_PROMPT_RENDER_CAPABILITY_KEYS.includes(capabilityKey) &&
    SEEDANCE_RATIOS.includes(profile.ratio as never) &&
    SEEDANCE_RESOLUTIONS.includes(profile.resolution as never) &&
    capability.ratios.includes(profile.ratio as never) &&
    capability.resolutions.includes(profile.resolution as never) &&
    Object.keys(constraints).length === 2 &&
    disabledElements.length <= 100 &&
    disabledElements.every(
      (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500,
    ) &&
    new Set(disabledElements.map((item) => normalizedValue(String(item)))).size ===
      disabledElements.length &&
    typeof constraints.contentHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(constraints.contentHash) &&
    constraints.contentHash === sha256Json(disabledElements),
  );
};

export const recomputePromptQuality = (
  rawItems: EffectPromptItem[],
  rawSettings: EffectPromptBatchSettings,
  previous?: Partial<EffectPromptMetrics>,
  renderProfile: EffectPromptRenderProfile = defaultEffectPromptRenderProfile(),
  sharedPrompt?: EffectPromptSharedPrompt,
  semanticEvaluationOverride?: EffectPromptSemanticEvaluation,
): Pick<
  EffectPromptBatchResult,
  'settings' | 'renderProfile' | 'sharedPrompt' | 'items' | 'metrics' | 'qualityStatus'
> => {
  const settings = normalizeEffectPromptSettings(rawSettings);
  const items = rawItems.filter(isEffectPromptItem);
  const exactDuplicatePairs = effectPromptExactDuplicatePairs(items);
  const classifiedItems = items.filter((item) => item.classificationStatus === 'VERIFIED');
  const purposeDistribution = EFFECT_PROMPT_FRAGMENT_TYPES.map((purpose) => ({
    purpose,
    primaryCount: classifiedItems.filter((item) => item.primaryPurpose === purpose).length,
    compatibleCount: classifiedItems.filter((item) => item.compatiblePurposes.includes(purpose))
      .length,
  }));
  const hardIssueCounts = new Map<string, number>(
    (previous?.hardIssueCounts ?? [])
      .filter(
        ({ code }) =>
          ![
            'CLASSIFICATION_PENDING',
            'ITEM_NEEDS_REVISION',
            'DURATION_MISMATCH',
            'EXACT_DUPLICATE',
            'MISSING_DEEP_BUSINESS_FACT',
          ].includes(code),
      )
      .map(({ code, count }) => [code, count]),
  );
  for (const prompt of items) {
    if (prompt.classificationStatus === 'PENDING')
      hardIssueCounts.set(
        'CLASSIFICATION_PENDING',
        (hardIssueCounts.get('CLASSIFICATION_PENDING') ?? 0) + 1,
      );
    if (prompt.classificationStatus === 'NEEDS_REVISION')
      hardIssueCounts.set(
        'ITEM_NEEDS_REVISION',
        (hardIssueCounts.get('ITEM_NEEDS_REVISION') ?? 0) + 1,
      );
    if (prompt.targetDurationSeconds !== settings.defaultDurationSeconds)
      hardIssueCounts.set('DURATION_MISMATCH', (hardIssueCounts.get('DURATION_MISMATCH') ?? 0) + 1);
  }
  if (exactDuplicatePairs > 0) hardIssueCounts.set('EXACT_DUPLICATE', exactDuplicatePairs);
  const normalizedHardIssues = [...hardIssueCounts]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([code, count]) => ({ code, count }));
  const averageProductRelevance = items.length
    ? Math.round(
        (items.reduce((sum, item) => sum + item.productRelevance, 0) / items.length) * 100,
      ) / 100
    : 0;
  const previousScores = previous?.averageScores;
  const semanticEvaluation = validSemanticEvaluation(semanticEvaluationOverride)
    ? semanticEvaluationOverride
    : validSemanticEvaluation(previous?.semanticEvaluation)
      ? previous.semanticEvaluation
      : pendingEffectPromptSemanticEvaluation();
  const previousCoverage = previous?.insightCoverage ?? {
    required: [],
    covered: [],
    missing: [],
    adaptive: [],
    deferred: [],
    excluded: [],
    appliedConstraints: [],
  };
  const boundFactIds = new Set(
    items.flatMap((item) => item.insightBindings.map((binding) => binding.factId)),
  );
  const insightCoverage: EffectPromptInsightCoverage = {
    ...previousCoverage,
    covered: previousCoverage.required.filter(({ factId }) => boundFactIds.has(factId)),
    missing: previousCoverage.required.filter(({ factId }) => !boundFactIds.has(factId)),
    deferred: previousCoverage.adaptive.filter(({ factId }) => !boundFactIds.has(factId)),
  };
  const metrics: EffectPromptMetrics = {
    targetCount: settings.targetCount,
    candidateTargetCount: Math.min(240, Math.ceil(settings.targetCount * 1.2)),
    acceptedCount: items.length,
    generatedCandidateCount: Math.max(
      previous?.generatedCandidateCount ?? items.length,
      items.length,
    ),
    rejectedCount: Math.max(previous?.rejectedCount ?? 0, 0),
    replenishmentRounds: Math.min(
      EFFECT_PROMPT_LIMITS.maxReplenishmentRounds,
      Math.max(previous?.replenishmentRounds ?? 0, 0),
    ),
    exactDuplicateCount: exactDuplicatePairs,
    semanticEvaluation,
    purposeDistribution,
    averageScores: {
      productRelevance: averageProductRelevance,
      creativeCoherence: previousScores?.creativeCoherence ?? 0,
      visualExecutability: previousScores?.visualExecutability ?? 0,
      commercialUsefulness: previousScores?.commercialUsefulness ?? 0,
      visualClarity: previousScores?.visualClarity ?? 0,
    },
    hardIssueCounts: normalizedHardIssues,
    warningCounts: previous?.warningCounts ?? [],
    insightCoverage,
  };
  const qualityStatus =
    items.length === settings.targetCount &&
    exactDuplicatePairs === 0 &&
    normalizedHardIssues.length === 0 &&
    items.every(({ classificationStatus }) => classificationStatus === 'VERIFIED') &&
    insightCoverage.missing.length === 0
      ? 'PASS'
      : 'NEEDS_REVIEW';
  return {
    settings,
    renderProfile,
    ...(sharedPrompt ? { sharedPrompt } : {}),
    items,
    metrics,
    qualityStatus,
  };
};

export const parseEffectPromptBatchResult = (value: unknown): EffectPromptBatchResult | null => {
  const source = record(value);
  const candidate: Record<string, unknown> | null = source
    ? {
        ...source,
        items: Array.isArray(source.items)
          ? source.items.map(withCurrentItemCompatibility)
          : source.items,
        metrics: withCurrentMetricsCompatibility(source.metrics),
      }
    : null;
  if (
    !candidate ||
    !isEffectPromptSettings(candidate.settings) ||
    !isEffectPromptRenderProfile(candidate.renderProfile) ||
    !Array.isArray(candidate.items) ||
    candidate.items.length > EFFECT_PROMPT_LIMITS.maxCount ||
    !validMetrics(candidate.metrics) ||
    !['PASS', 'NEEDS_REVIEW'].includes(String(candidate.qualityStatus)) ||
    ![5, 6].includes(Object.keys(candidate).length) ||
    (candidate.sharedPrompt !== undefined &&
      !isEffectPromptSharedPrompt(
        candidate.sharedPrompt,
        candidate.renderProfile.sharedConstraints.disabledElements,
      ))
  )
    return null;
  const normalizedItems = candidate.items;
  const items = normalizedItems.filter(isEffectPromptItem);
  if (
    items.length !== normalizedItems.length ||
    new Set(items.map(({ id }) => id)).size !== items.length
  )
    return null;
  return recomputePromptQuality(
    items,
    candidate.settings,
    record(candidate.metrics) as Partial<EffectPromptMetrics> | undefined,
    candidate.renderProfile,
    candidate.sharedPrompt,
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
  const targetNeedsCreativeStructure =
    target.creativeCore.trim() === '等待 AI 分析' ||
    EFFECT_PROMPT_DIMENSIONS.some(({ key }) => target.dimensions[key].trim() === '等待 AI 分析');
  const stableReplacement: EffectPromptItem =
    snapshot.operation === 'ITEM_EVALUATE'
      ? {
          ...target,
          fragmentType: target.primaryPurpose,
          primaryPurpose: target.primaryPurpose,
          compatiblePurposes: [
            target.primaryPurpose,
            ...replacement.compatiblePurposes.filter(
              (purpose) => purpose !== target.primaryPurpose,
            ),
          ],
          classificationStatus: replacement.classificationStatus,
          productRelevance: replacement.productRelevance,
          creativeCore: targetNeedsCreativeStructure
            ? replacement.creativeCore
            : target.creativeCore,
          dimensions: targetNeedsCreativeStructure
            ? { ...replacement.dimensions }
            : { ...target.dimensions },
          insightBindings: [...replacement.insightBindings],
          reviewIssues: [...(replacement.reviewIssues ?? [])],
          updatedAt: replacement.updatedAt,
        }
      : {
          ...replacement,
          id: target.id,
          code: target.code,
          origin: 'AI',
          targetDurationSeconds: target.targetDurationSeconds,
          manualEdited: false,
          createdAt: target.createdAt,
        };
  const merged = [...snapshot.retainedManualItems];
  merged.splice(Math.min(Math.max(targetIndex, 0), merged.length), 0, stableReplacement);
  return merged;
};
