export const ASSET_DETAIL_KEYS = {
  PRODUCT: ['structure', 'material', 'markings'],
  CHARACTER: ['appearance', 'styling'],
  SCENE: ['layout', 'lighting'],
  PROP: ['appearance', 'material'],
} as const;
export const ASSET_FIELD_LABELS: Record<string, string> = {
  structure: '结构与形态',
  material: '材质与颜色',
  markings: '标识与位置',
  appearance: '外形特征',
  styling: '服装与造型',
  layout: '空间与陈设',
  lighting: '光线与氛围',
  description: '公共形象',
  knownFacts: '已确认信息',
  designNotes: '设计内容',
  imageRequirements: '图片制作要求',
  preparation: '分类定义',
  name: '名称',
  sourceText: '依据说明',
};
export type AssetEvidence = {
  source: 'BRIEF' | 'SCRIPT';
  path: string;
  quote: string;
  field: string;
};
export type AssetPreparation = {
  aliases: string[];
  usage: string;
  treatment: 'INDEPENDENT' | 'SCENE_DETAIL' | 'CHARACTER_DETAIL';
  parentId: string | null;
  sources: AssetEvidence[];
  details: { key: string; value: string }[];
  questions: { field: string; question: string; impact: string }[];
  images: { name: string; purpose: string; requirements: string }[];
};
export const ASSET_EDITABLE_FIELDS = [
  'name',
  'description',
  'knownFacts',
  'designNotes',
  'sourceText',
  'imageRequirements',
  'preparation',
] as const;
export const ASSET_STAGES = [
  { id: 'SNAPSHOT', label: '故事与资料', description: '查看本次采用的故事、产品信息和品牌要求' },
  { id: 'INVENTORY', label: '识别故事对象', description: '找出出场对象，说明作用与原文依据' },
  {
    id: 'IDENTITY',
    label: '对象归属与复用',
    description: '确认沿用哪些对象，哪些随人物或场景准备',
  },
  { id: 'PRODUCT', label: '产品定义', description: '核对产品结构、材质和标识' },
  { id: 'CHARACTER', label: '人物定义', description: '整理样貌和服装造型' },
  { id: 'SCENE', label: '场景定义', description: '整理空间布局和基础光线' },
  { id: 'PROP', label: '道具定义', description: '整理物件形态及必要条件' },
  { id: 'IMAGE_PLAN', label: '图片制作需求', description: '整理可按需制作的参考图清单' },
  { id: 'REVIEW', label: '资产核对', description: '查看具体问题、资料依据和处理建议' },
  { id: 'REPAIR', label: '问题修正与复核', description: '查看修改前后内容和复核结论' },
  { id: 'SAVE', label: '保存资产草稿', description: '查看整理结果与后续使用安排' },
] as const;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && v.length <= 20000;
const rows = (v: unknown, test: (v: unknown) => boolean) =>
  Array.isArray(v) && v.length <= 1000 && v.every(test);
export function isAssetPreparation(v: unknown): v is AssetPreparation {
  return (
    object(v) &&
    rows(v.aliases, text) &&
    text(v.usage) &&
    ['INDEPENDENT', 'SCENE_DETAIL', 'CHARACTER_DETAIL'].includes(String(v.treatment)) &&
    (v.parentId === null || (typeof v.parentId === 'string' && !!v.parentId.trim())) &&
    rows(
      v.sources,
      (s) =>
        object(s) &&
        ['BRIEF', 'SCRIPT'].includes(String(s.source)) &&
        text(s.path) &&
        text(s.quote) &&
        !!s.quote &&
        text(s.field),
    ) &&
    rows(v.details, (d) => object(d) && text(d.key) && text(d.value)) &&
    rows(v.questions, (q) => object(q) && text(q.field) && text(q.question) && text(q.impact)) &&
    rows(v.images, (i) => object(i) && text(i.name) && text(i.purpose) && text(i.requirements))
  );
}
/** Resolve only own JSON properties. Paths are slash-separated, JSON-pointer escaped. */
export function assetEvidenceValue(root: unknown, path: string): unknown {
  let value = root;
  if (!path.startsWith('/')) return undefined;
  for (const part of path.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
