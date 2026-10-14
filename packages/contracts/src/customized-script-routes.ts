import { COMMERCE_CREATION_VERSION, isCommerceStrategy, isPresenterStrategy } from './customized-commerce-creation';
import { DRAMA_CREATION_VERSION, isDramaStrategy } from './customized-drama-creation';
import type { CustomizedVideoType } from './customized-storyboard';
import type { StoryboardInput, StoryboardStory } from './customized-storyboard-generation';

export const TYPED_CREATION_VERSION = 'TYPED_CREATION_V1' as const;
export const SCRIPT_ROUTE_VERSION = '2026-10-14.7';
export const scriptStrategyVersion = (route: CustomizedVideoType) => route === 'ECOMMERCE' ? COMMERCE_CREATION_VERSION : route === 'DRAMA' ? DRAMA_CREATION_VERSION : SCRIPT_ROUTE_VERSION;
export const SCRIPT_QUALITY_CRITERIA = {
  ECOMMERCE: ['BUYING_REASON', 'VALUE_DEMONSTRATION', 'INFORMATION_CAPACITY'],
  LOCAL_STORE: ['VENUE_EVIDENCE', 'VISIT_EXPERIENCE', 'TRUSTWORTHY_DETAIL'],
  BRAND_AD: ['VISIBLE_CONCEPT', 'VISUAL_PROGRESSION', 'BRAND_MEMORY'],
  DRAMA: ['CHARACTER_CAUSALITY', 'NATURAL_DIALOGUE', 'PRODUCT_CAUSALITY'],
} as const;
export type ScriptQualityCheck = {
  criterion: (typeof SCRIPT_QUALITY_CRITERIA)[CustomizedVideoType][number];
  verdict: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  beatIds: string[];
  evidence: string;
  reason: string;
  suggestion: string;
};
export const SCRIPT_ROUTE_LABELS = {
  ECOMMERCE: '口播',
  LOCAL_STORE: '到店',
  BRAND_AD: '品牌',
  DRAMA: '剧情',
} as const;
export type TypedScriptStage =
  'PREPARE' | 'ROUTE' | 'RECHECK' | 'ECOMMERCE_MOTIVATION' | 'BRAND_AD_PROPOSITION' | 'BRAND_AD_IDEAS' | `${CustomizedVideoType}_${'CONCEPT' | 'STORY' | 'REVIEW'}`;
export type ScriptStructureMapping = { requirementId: string; beatIds: string[]; evidence: string };
export const SCRIPT_PLAN_FIELDS = {
  ECOMMERCE: {
    buyingReason: '购买理由',
    audienceSituation: '受众处境',
    demonstration: '价值呈现',
    progression: '内容推进',
    ending: '行动与收束',
  },
  LOCAL_STORE: {
    visitReason: '到店理由',
    venueEvidence: '门店依据',
    experiencePath: '体验过程',
    serviceValue: '服务价值',
    ending: '到店引导',
  },
  BRAND_AD: {
    brandImpression: '品牌印象',
    visualConcept: '视觉概念',
    visualProgression: '视觉推进',
    productConnection: '产品关联',
    ending: '品牌记忆',
  },
  DRAMA: {
    desire: '人物目标',
    obstacle: '阻碍',
    relationships: '人物关系',
    trigger: '触发事件',
    escalation: '情节发展',
    choice: '关键选择',
    consequence: '后果与变化',
    productCausality: '产品参与',
  },
} as const;
export type ScriptCreativePlan = {
  [K in CustomizedVideoType]: { videoType: K } & Record<
    keyof (typeof SCRIPT_PLAN_FIELDS)[K],
    string
  >;
}[CustomizedVideoType];
export type ScriptReadiness = {
  status: 'READY' | 'NEEDS_INFORMATION';
  reason: string;
  missing: string[];
};
export const typedScriptStages = (route: CustomizedVideoType, version?: string) =>
  [
    {
      id: 'SNAPSHOT',
      label: '信息卡快照',
      description: '本次已确认的产品事实与品牌约束',
      weight: 5,
    },
    {
      id: 'PREPARE',
      label: '创作依据准备',
      description: '整理来源、结构要求与创作范围',
      weight: 5,
    },
    { id: 'ROUTE', label: '视频类型路由', description: '按本次选择进入专属创作线路', weight: 0 },
    ...(route === 'ECOMMERCE' && isCommerceStrategy(version) ? [{ id: 'ECOMMERCE_MOTIVATION' as const, label: isPresenterStrategy(version) ? '口播推荐策略与创意' : '购买动机与演示策划', description: isPresenterStrategy(version) ? '设计讲述者、推荐逻辑、具体创意和演示分工' : '围绕具体购买问题设计有依据的价值演示', weight: 7 }] : []),
    ...(route === 'BRAND_AD' && ['2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'].includes(version ?? '') ? [
      { id: 'BRAND_AD_PROPOSITION' as const, label: '品牌传播命题', description: '从简报明确主要表达、受众观察与事实边界', weight: 4 },
      { id: 'BRAND_AD_IDEAS' as const, label: '品牌短创意开发', description: '比较不同观看机制的短创意', weight: 5 },
    ] : []),
    {
      id: `${route}_CONCEPT`,
      label: route === 'DRAMA' && isDramaStrategy(version) ? '剧情开发与独立择优' : route === 'ECOMMERCE' && isCommerceStrategy(version) ? (isPresenterStrategy(version) ? '口播创意独立择优' : '带货方案独立择优') : route === 'BRAND_AD' && ['2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'].includes(version ?? '') ? '品牌创意独立择优' : `${SCRIPT_ROUTE_LABELS[route]}方案构思`,
      description: route === 'BRAND_AD' && ['2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'].includes(version ?? '') ? '独立比较候选，确定方案与创意保留清单' : '判断资料依据并规划差异化方案',
      weight: route === 'BRAND_AD' && ['2026-10-14.1', '2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'].includes(version ?? '') ? 6 : 15,
    },
    {
      id: `${route}_STORY`,
      label: `${SCRIPT_ROUTE_LABELS[route]}脚本创作`,
      description: '按本类型创作计划展开完整正文',
      weight: 40,
    },
    {
      id: `${route}_REVIEW`,
      label: `${SCRIPT_ROUTE_LABELS[route]}专项审校`,
      description: '核对事实、内容容量及本类型创作质量',
      weight: 20,
    },
    { id: 'REPAIR', label: '定向修订', description: '修改已指出的实质问题', weight: 8 },
    { id: 'RECHECK', label: '独立复核', description: '核对修订后的全文与原问题', weight: 5 },
    { id: 'SAVE', label: '保存脚本分支', description: '通过校验后保存当前完整脚本', weight: 2 },
  ] as const;
export function isSharedScriptStage(node: string): boolean {
  return ['SNAPSHOT', 'PREPARE', 'ROUTE', 'CONCEPT', 'BRAND_AD_PROPOSITION', 'BRAND_AD_IDEAS', 'ECOMMERCE_MOTIVATION'].includes(node) || node.endsWith('_CONCEPT') || node.endsWith('_MOTIVATION');
}
export function scriptStageRole(node: string): string {
  return /_(CONCEPT|STORY|REVIEW)$/.exec(node)?.[1] ?? node;
}
export function structureRequirements(input: Pick<StoryboardInput, 'settings'>) {
  return (
    input.settings.structureMode === 'AI' ? [] : (input.settings.structureSections ?? [])
  ).map((title, i) => ({ id: `R${String(i + 1).padStart(2, '0')}`, title }));
}
export function validateScriptStructureMapping(
  story: Pick<StoryboardStory, 'beats' | 'structureMapping'>,
  sections: string[],
): string | null {
  const mapping = story.structureMapping;
  if (!Array.isArray(mapping) || mapping.length !== sections.length)
    return '脚本结构落实记录不完整';
  let previous = -1;
  for (const [i, item] of mapping.entries()) {
    if (
      item.requirementId !== `R${String(i + 1).padStart(2, '0')}` ||
      !Array.isArray(item.beatIds) ||
      !item.beatIds.length ||
      new Set(item.beatIds).size !== item.beatIds.length ||
      typeof item.evidence !== 'string' ||
      item.evidence.length > 200 ||
      !item.evidence.trim()
    )
      return '脚本结构引用不完整';
    const positions = item.beatIds.map((id) => story.beats.findIndex((b) => b.id === id));
    if (
      positions.some((p, j) => p < 0 || (j > 0 && p <= positions[j - 1]!)) ||
      positions[0]! < previous
    )
      return '脚本结构引用或推进顺序无效';
    if (
      !item.beatIds.some((id) =>
        story.beats.find((b) => b.id === id)?.content.includes(item.evidence),
      )
    )
      return '结构落实依据必须引用对应正文';
    previous = positions[0]!;
  }
  return null;
}
