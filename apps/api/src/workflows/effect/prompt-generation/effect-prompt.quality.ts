import { createHash } from 'node:crypto';
import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptBatchResultV5,
  EffectPromptBatchSettingsV5,
  EffectPromptDimensions,
  EffectPromptDimensionsV5,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptItemV5,
  EffectPromptInsightBinding,
  EffectPromptInsightCoverage,
  EffectPromptInsightReference,
  EffectPromptInsightRole,
  EffectPromptMetrics,
  EffectPromptMetricsV5,
  EffectPromptRenderProfile,
  EffectPromptSharedPrompt,
  EffectPromptSharedPromptSection,
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
  EFFECT_PROMPT_LEGACY_SCHEMA_VERSION,
  EFFECT_PROMPT_V5_DIMENSIONS,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
  effectPromptTargetCount,
  migrateEffectPromptSettingsV5,
  normalizeEffectPromptSettings,
  normalizeEffectPromptSettingsV5,
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
  productRelation: 240,
  camera: 160,
  emotion: 120,
};
const dimensionTextLimitsV5: Record<keyof EffectPromptDimensionsV5, number> = {
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
const PAIN_RESOLVED =
  /(?:(?:使用|拿出|换上|放入).{0,24}(?:解决|完成|恢复|顺利)|问题(?:被|已)?解决|不便消失|轻松完成)/u;
const PRODUCT_EFFECT_LEAK =
  /(?:使用后|效果对比|前后对比|问题解决|明显改善|立刻见效|满意(?:微笑|点头)|证明(?:效果|功效))/u;
const PACKAGED_STATE = /(?:真空袋装|袋装|包装|袋身)/u;
const UNPACKAGED_END_STATE = /(?:最终|结束时|随后|转眼).{0,80}(?:蒸笼|盘中|碗中|切片|散装|裸露)/u;
const PACKAGE_TRANSITION_ACTION = /(?:打开|拆开|撕开|取出|倒出|拿出)/u;
const SAFE_AREA = /(?:留白|安全区|干净空间|简洁背景|无遮挡空间|空白墙面|空白区域|干净无遮挡)/u;
const OUTRO_UNSTABLE =
  /(?:快速|奔跑|跳跃|连续旋转|跟拍|跟随|手持|环绕|横移|侧移|推近|推进|靠近|后拉|拉远)/u;
const OUTRO_SUBTLE_MOTION =
  /(?:扶正|离开|收焦|焦点.{0,12}(?:落到|稳定|清楚)|光线.{0,12}(?:稳定|恢复)|蒸汽.{0,12}(?:变缓|减弱|停止)|背景.{0,12}(?:稳定|安静)|轻微变化)/u;
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
  if (
    !VISIBLE_ACTION.test(content) &&
    !(item.fragmentType === 'OUTRO' && OUTRO_SUBTLE_MOTION.test(content))
  )
    issues.push('NO_VISIBLE_ACTION');
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
  if (item.fragmentType === 'PAIN' && PAIN_RESOLVED.test(content)) issues.push('PAIN_RESOLVED');
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
    item.fragmentType === 'SELLING_POINT_EXPLANATION' &&
    !ABSTRACT_SELLING_POINT.test(item.dimensions.productRelation) &&
    ATTRIBUTE_SELLING_POINT.test(item.dimensions.productRelation) &&
    !ATTRIBUTE_CUE.test(content)
  )
    issues.push('EVIDENCE_MODE_MISMATCH');
  if (item.fragmentType === 'CTA' && !SAFE_AREA.test(content)) issues.push('CTA_NO_SAFE_AREA');
  if (item.fragmentType === 'OUTRO') {
    if (
      OUTRO_UNSTABLE.test(content) &&
      !(
        /(?:极缓慢|缓慢|轻微)/u.test(content) &&
        /(?:停稳|完全静止|定格|稳定构图|最终静止)/u.test(content)
      )
    )
      issues.push('OUTRO_UNSTABLE');
    const introducesSellingPoint = item.insightBindings.some(
      (binding) =>
        ['CORE_SELLING_POINT', 'SECONDARY_SELLING_POINT'].includes(binding.field) &&
        content.includes(binding.value),
    );
    if (introducesSellingPoint) issues.push('OUTRO_NEW_MESSAGE');
  }
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

const validDimensionsV5 = (value: unknown): value is EffectPromptDimensionsV5 => {
  const candidate = record(value);
  return Boolean(
    candidate &&
    Object.keys(candidate).length === EFFECT_PROMPT_V5_DIMENSIONS.length &&
    EFFECT_PROMPT_V5_DIMENSIONS.every(
      ({ key }) =>
        typeof candidate[key] === 'string' &&
        candidate[key].trim().length > 0 &&
        candidate[key].length <= dimensionTextLimitsV5[key],
    ),
  );
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

export const isEffectPromptItemV5 = (value: unknown): value is EffectPromptItemV5 => {
  const item = record(value);
  return Boolean(
    item &&
    validBaseItem(item) &&
    validDimensionsV5(item.dimensions) &&
    Object.keys(item).length === 12,
  );
};

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
    (item.classificationStatus === 'PENDING' || item.classificationStatus === 'VERIFIED') &&
    Number.isInteger(item.productRelevance) &&
    Number(item.productRelevance) >= 0 &&
    Number(item.productRelevance) <= 100 &&
    Object.keys(item).length === 16,
  );
};

export const isEffectPromptSettingsV5 = (value: unknown): value is EffectPromptBatchSettingsV5 => {
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

const validMetricsV5 = (value: unknown): value is EffectPromptMetricsV5 => {
  const metrics = record(value);
  if (!metrics || Object.keys(metrics).length !== 15) return false;
  const integer = (key: keyof EffectPromptMetricsV5, minimum: number, maximum = Infinity) =>
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

const validMetrics = (value: unknown): value is EffectPromptMetrics => {
  const metrics = record(value);
  if (!metrics || Object.keys(metrics).length !== 11) return false;
  const integer = (key: keyof EffectPromptMetrics, minimum: number, maximum = Infinity) =>
    Number.isInteger(metrics[key]) &&
    Number(metrics[key]) >= minimum &&
    Number(metrics[key]) <= maximum;
  const distribution = metrics.purposeDistribution;
  const scores = record(metrics.averageScores);
  return Boolean(
    integer('targetCount', EFFECT_PROMPT_LIMITS.minCount, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('candidateTargetCount', EFFECT_PROMPT_LIMITS.minCount, 240) &&
    integer('generatedCandidateCount', 0) &&
    integer('acceptedCount', 0, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('rejectedCount', 0) &&
    integer(
      'replenishmentRounds',
      0,
      EFFECT_PROMPT_LIMITS.maxReplenishmentRounds,
    ) &&
    integer('exactDuplicateCount', 0) &&
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
    validIssueCounts(metrics.warningCounts),
  );
};

export const defaultEffectPromptRenderProfile = (): EffectPromptRenderProfile => ({
  ratio: '9:16',
  resolution: '1080p',
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

const sharedConstraintContentHash = (disabledElements: string[], prompt: string): string =>
  createHash('sha256').update(JSON.stringify({ disabledElements, prompt })).digest('hex');

const sha256Text = (value: string): string => createHash('sha256').update(value).digest('hex');
const sha256Json = (value: unknown): string => sha256Text(JSON.stringify(value));

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
    schemaVersion: 1,
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
    prompt.schemaVersion !== 1 ||
    Object.keys(prompt).length !== 4 ||
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
  const prompt = constraints.prompt;
  const hasPrompt = typeof prompt === 'string';
  const expectedPrompt = compileEffectPromptSharedConstraintPrompt(
    disabledElements.filter((item): item is string => typeof item === 'string'),
  );
  return Boolean(
    Object.keys(profile).length === 4 &&
    EFFECT_PROMPT_RENDER_CAPABILITY_KEYS.includes(capabilityKey) &&
    SEEDANCE_RATIOS.includes(profile.ratio as never) &&
    SEEDANCE_RESOLUTIONS.includes(profile.resolution as never) &&
    capability.ratios.includes(profile.ratio as never) &&
    capability.resolutions.includes(profile.resolution as never) &&
    [2, 3].includes(Object.keys(constraints).length) &&
    disabledElements.length <= 100 &&
    disabledElements.every(
      (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500,
    ) &&
    new Set(disabledElements.map((item) => normalizedValue(String(item)))).size ===
      disabledElements.length &&
    (!hasPrompt || (prompt.length <= 60_000 && prompt === expectedPrompt)) &&
    typeof constraints.contentHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(constraints.contentHash) &&
    (hasPrompt
      ? constraints.contentHash === sharedConstraintContentHash(disabledElements, prompt)
      : constraints.contentHash === sha256Json(disabledElements)),
  );
};

export const recomputePromptQuality = (
  rawItems: EffectPromptItem[],
  rawSettings: EffectPromptBatchSettings,
  previous?: Partial<EffectPromptMetrics>,
  renderProfile: EffectPromptRenderProfile = defaultEffectPromptRenderProfile(),
  sharedPrompt?: EffectPromptSharedPrompt,
): Pick<
  EffectPromptBatchResult,
  | 'schemaVersion'
  | 'settings'
  | 'renderProfile'
  | 'sharedPrompt'
  | 'items'
  | 'metrics'
  | 'qualityStatus'
> => {
  const settings = normalizeEffectPromptSettings(rawSettings);
  const items = rawItems.filter(isEffectPromptItem);
  const exactDuplicatePairs = effectPromptExactDuplicatePairs(items);
  const purposeDistribution = EFFECT_PROMPT_FRAGMENT_TYPES.map((purpose) => ({
    purpose,
    primaryCount: items.filter((item) => item.primaryPurpose === purpose).length,
    compatibleCount: items.filter((item) => item.compatiblePurposes.includes(purpose)).length,
  }));
  const hardIssueCounts = new Map<string, number>(
    (previous?.hardIssueCounts ?? [])
      .filter(
        ({ code }) =>
          !['CLASSIFICATION_PENDING', 'DURATION_MISMATCH', 'EXACT_DUPLICATE'].includes(code),
      )
      .map(({ code, count }) => [code, count]),
  );
  for (const prompt of items) {
    if (prompt.classificationStatus !== 'VERIFIED')
      hardIssueCounts.set(
        'CLASSIFICATION_PENDING',
        (hardIssueCounts.get('CLASSIFICATION_PENDING') ?? 0) + 1,
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
  };
  const qualityStatus =
    items.length === settings.targetCount &&
    exactDuplicatePairs === 0 &&
    normalizedHardIssues.length === 0 &&
    items.every(({ classificationStatus }) => classificationStatus === 'VERIFIED')
      ? 'PASS'
      : 'NEEDS_REVIEW';
  return {
    schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
    settings,
    renderProfile,
    ...(sharedPrompt ? { sharedPrompt } : {}),
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
    ![6, 7].includes(Object.keys(candidate).length) ||
    (candidate.sharedPrompt !== undefined &&
      !isEffectPromptSharedPrompt(
        candidate.sharedPrompt,
        candidate.renderProfile.sharedConstraints.disabledElements,
      ))
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
    candidate.sharedPrompt,
  );
};

export const parseEffectPromptBatchResultV5ForRead = (
  value: unknown,
): EffectPromptBatchResultV5 | null => {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.schemaVersion !== EFFECT_PROMPT_LEGACY_SCHEMA_VERSION ||
    !isEffectPromptSettingsV5(candidate.settings) ||
    !isEffectPromptRenderProfile(candidate.renderProfile) ||
    !Array.isArray(candidate.items) ||
    candidate.items.length > EFFECT_PROMPT_LIMITS.maxCount ||
    !validMetricsV5(candidate.metrics) ||
    !['PASS', 'NEEDS_REVIEW'].includes(String(candidate.qualityStatus)) ||
    ![6, 7].includes(Object.keys(candidate).length) ||
    (candidate.sharedPrompt !== undefined &&
      !isEffectPromptSharedPrompt(
        candidate.sharedPrompt,
        candidate.renderProfile.sharedConstraints.disabledElements,
      ))
  )
    return null;
  const items = candidate.items.filter(isEffectPromptItemV5);
  if (
    items.length !== candidate.items.length ||
    new Set(items.map(({ id }) => id)).size !== items.length
  )
    return null;
  return {
    schemaVersion: EFFECT_PROMPT_LEGACY_SCHEMA_VERSION,
    settings: normalizeEffectPromptSettingsV5(candidate.settings),
    renderProfile: candidate.renderProfile,
    ...(candidate.sharedPrompt ? { sharedPrompt: candidate.sharedPrompt } : {}),
    items,
    metrics: candidate.metrics,
    qualityStatus: candidate.qualityStatus as EffectPromptBatchResultV5['qualityStatus'],
  };
};

export const parseLegacyV4EffectPromptBatchResultForRead = (
  value: unknown,
): EffectPromptBatchResultV5 | null => {
  const candidate = record(value);
  if (!candidate || candidate.schemaVersion !== 4 || !Array.isArray(candidate.items)) return null;
  const settings = migrateEffectPromptSettingsV5(candidate.settings, 4);
  const items = candidate.items.map((value) => {
    const item = record(value);
    if (!item || typeof item.fragmentType !== 'string') return null;
    const fragmentType = item.fragmentType as EffectPromptFragmentType;
    if (!EFFECT_PROMPT_FRAGMENT_TYPES.includes(fragmentType)) return null;
    const migrated = {
      ...item,
      targetDurationSeconds: settings.fragmentConfigs[fragmentType].durationSeconds,
    };
    return isEffectPromptItemV5(migrated) ? migrated : null;
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
      prompt: compileEffectPromptSharedConstraintPrompt(disabledElements),
      contentHash: sharedConstraintContentHash(
        disabledElements,
        compileEffectPromptSharedConstraintPrompt(disabledElements),
      ),
    },
  };
  if (!validMetricsV5(candidate.metrics)) return null;
  return {
    schemaVersion: EFFECT_PROMPT_LEGACY_SCHEMA_VERSION,
    settings,
    renderProfile,
    items: items as EffectPromptItemV5[],
    metrics: candidate.metrics,
    qualityStatus: candidate.qualityStatus === 'PASS' ? 'PASS' : 'NEEDS_REVIEW',
  };
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
  const stableReplacement: EffectPromptItem =
    snapshot.operation === 'ITEM_EVALUATE'
      ? {
          ...target,
          fragmentType: replacement.primaryPurpose,
          primaryPurpose: replacement.primaryPurpose,
          compatiblePurposes: [...replacement.compatiblePurposes],
          classificationStatus: replacement.classificationStatus,
          productRelevance: replacement.productRelevance,
          insightBindings: [...replacement.insightBindings],
          updatedAt: replacement.updatedAt,
        }
      : {
          ...replacement,
          id: target.id,
          code: target.code,
          origin: 'AI',
          materialTags: [...target.materialTags],
          targetDurationSeconds: target.targetDurationSeconds,
          manualEdited: false,
          createdAt: target.createdAt,
        };
  const merged = [...snapshot.retainedManualItems];
  merged.splice(Math.min(Math.max(targetIndex, 0), merged.length), 0, stableReplacement);
  return merged;
};
