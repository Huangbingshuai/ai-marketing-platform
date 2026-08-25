import type {
  EffectExtractionNodeDetail,
  EffectExtractionNodeDetailField,
  EffectExtractionNodeDetailSource,
  EffectExtractionNodeDetailValue,
  EffectExtractionNodeExecution,
  EffectExtractionNodeId,
  EffectExtractionNodeStatus,
} from '@ai-marketing/contracts';

import type { EffectExtractionInputSnapshot } from './effect-extraction.types';

type DetailBranchRecord = {
  branch: 'DOCUMENT' | 'IMAGE' | 'COMMERCE' | 'FORM' | 'FUSION' | 'NORMALIZATION';
  status: EffectExtractionNodeStatus;
  structuredOutput?: unknown;
  updatedAt: Date;
};

type DetailResultRecord = {
  draftResult: unknown;
  provenance: unknown;
  conflictReport: unknown;
  revision: number;
  savedAt: Date | null;
  updatedAt: Date;
};

export type ExtractionNodeDetailRecord = {
  inputSnapshot: unknown;
  updatedAt: Date;
  branches?: DetailBranchRecord[];
  result?: DetailResultRecord | null;
};

type JsonRecord = Record<string, unknown>;

const CANDIDATE_FIELDS = [
  ['productCategory', '品类'],
  ['productName', '产品名称'],
  ['coreSpecification', '核心规格'],
  ['priceRange', '价格带'],
  ['visualFeatures', '核心外观特征'],
  ['coreSellingPoints', '核心卖点'],
  ['secondarySellingPoints', '次要卖点'],
  ['trustBackings', '辅助信任背书'],
  ['targetAudience', '目标受众画像'],
  ['corePainPoints', '核心痛点'],
  ['decisionDrivers', '决策动因'],
  ['marketingGoal', '营销目标'],
  ['usageScenarios', '核心使用场景'],
  ['purchaseScenarios', '购买场景'],
  ['emotionalScenarios', '情绪共鸣场景'],
  ['durationSeconds', '统一时长'],
  ['aspectRatio', '画幅'],
  ['deliveryChannels', '投放渠道'],
  ['disabledElements', '禁用元素'],
  ['visualStyleBaseline', '视觉风格基线'],
] as const;

const COMMERCE_CANDIDATE_FIELDS = [
  ['productName', '商品名称'],
  ['productCategory', '品类'],
  ['priceRange', '价格区间'],
  ['coreSpecification', '核心规格'],
  ['coreSellingPoints', '核心卖点'],
  ['secondarySellingPoints', '其他卖点'],
  ['trustBackings', '信任背书'],
  ['corePainPoints', '解决需求'],
  ['decisionDrivers', '购买理由'],
  ['usageScenarios', '使用场景'],
  ['purchaseScenarios', '购买场景'],
  ['emotionalScenarios', '情感场景'],
] as const;

const SOURCE_LABELS: Record<string, string> = {
  FORM: '人工表单',
  DOCUMENT: '文档解析',
  COMMERCE: '电商抓取',
  IMAGE: '图片识别',
  FUSION: '多源融合',
  NORMALIZATION: '标准化',
};

const MATERIAL_TYPE_LABELS: Record<string, string> = {
  PRODUCT_IMAGE: '商品图片',
  PRODUCT_DOCUMENT: '产品文档',
  BRAND_GUIDELINE: '品牌规范',
  REFERENCE_VIDEO: '参考视频',
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const publicText = (value: unknown, maxLength = 500): string =>
  String(value ?? '')
    .replace(/data:[^\s,]+;base64,[a-z\d+/=]+/giu, '[图片数据已隐藏]')
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '[链接已隐藏]')
    .replace(/[a-z]:\\(?:[^\\\s]+\\)+[^\s]+/giu, '[本地路径已隐藏]')
    .trim()
    .slice(0, maxLength);

const fileName = (value: unknown): string => {
  const name = publicText(
    String(value ?? '')
      .split(/[\\/]/)
      .at(-1),
    255,
  ).trim();
  return name || '未命名素材';
};

const safeValue = (
  value: unknown,
  includeEmpty: boolean,
): EffectExtractionNodeDetailValue | undefined => {
  if (typeof value === 'string') {
    const text = publicText(value);
    return text || (includeEmpty ? '' : undefined);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value === null) return includeEmpty ? null : undefined;
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => publicText(item, 160))
      .filter(Boolean)
      .slice(0, 20);
    return items.length || includeEmpty ? items : undefined;
  }
  return undefined;
};

const field = (
  key: string,
  label: string,
  value: unknown,
  source: string | null = null,
  includeEmpty = false,
): EffectExtractionNodeDetailField | null => {
  const safe = safeValue(value, includeEmpty);
  return safe === undefined ? null : { key, label, value: safe, source };
};

const fields = (
  values: Array<EffectExtractionNodeDetailField | null>,
): EffectExtractionNodeDetailField[] => values.filter((value) => value !== null);

const provenanceLabel = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .split('>')
    .map((part) => SOURCE_LABELS[part] ?? publicText(part, 40))
    .filter(Boolean)
    .join(' → ');
};

const candidateFields = (
  candidate: unknown,
  provenance: unknown = null,
  includeEmpty = false,
): EffectExtractionNodeDetailField[] => {
  const record = isRecord(candidate) ? candidate : {};
  const sources = isRecord(provenance) ? provenance : {};
  return fields(
    CANDIDATE_FIELDS.map(([key, label]) =>
      field(key, label, record[key], provenanceLabel(sources[key]), includeEmpty),
    ),
  );
};

const payload = (
  value: unknown,
): { candidate: unknown; items: unknown[]; metadata: JsonRecord } => {
  const record = isRecord(value) ? value : {};
  return {
    candidate: record.candidate,
    items: Array.isArray(record.items) ? record.items : [],
    metadata: isRecord(record.metadata) ? record.metadata : {},
  };
};

const safeWarnings = (values: unknown, excludedMessages: string[] = []): string[] => {
  const excluded = new Set(excludedMessages.map((value) => publicText(value)).filter(Boolean));
  const seen = new Set<string>();
  return (Array.isArray(values) ? values : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => publicText(value))
    .filter((value) => {
      if (!value || excluded.has(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, 20);
};

const status = (
  value: unknown,
  fallback: EffectExtractionNodeStatus,
): EffectExtractionNodeStatus =>
  ['PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'SKIPPED', 'FAILED'].includes(String(value))
    ? (value as EffectExtractionNodeStatus)
    : fallback;

const materialTypeLabel = (value: string): string => MATERIAL_TYPE_LABELS[value] ?? '资料文件';

const materialMedia = (
  snapshot: EffectExtractionInputSnapshot,
  material: EffectExtractionInputSnapshot['materials'][number],
): NonNullable<EffectExtractionNodeDetailSource['media']> => ({
  kind:
    material.type === 'PRODUCT_IMAGE'
      ? 'IMAGE'
      : material.type === 'PRODUCT_DOCUMENT' || material.type === 'BRAND_GUIDELINE'
        ? 'DOCUMENT'
        : material.type === 'REFERENCE_VIDEO'
          ? 'VIDEO'
          : 'FILE',
  typeLabel: materialTypeLabel(material.type),
  previewUrl:
    material.type === 'PRODUCT_IMAGE'
      ? `/api/projects/${encodeURIComponent(snapshot.projectId)}/workflows/effect/source-import/drafts/${snapshot.mode}/products/${encodeURIComponent(snapshot.product.id)}/materials/${encodeURIComponent(material.id)}/content`
      : null,
  sizeBytes: material.sizeBytes,
});

const commerceHost = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname.slice(0, 120);
  } catch {
    return null;
  }
};

const visibleCommerceUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 2000);
  } catch {
    return null;
  }
};

const structuredCommerceHost = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .slice(0, 120);
    return host || null;
  } catch {
    return null;
  }
};

const commerceFields = (
  candidate: unknown,
  metadata: JsonRecord,
  fallbackUrl: string | null,
): EffectExtractionNodeDetailField[] => {
  const record = isRecord(candidate) ? candidate : {};
  const host =
    structuredCommerceHost(metadata.sourceHost) ??
    (metadata.hasCommerceUrl === true ? commerceHost(fallbackUrl) : null);
  return fields([
    field('commerceHost', '来源网站', host),
    field('productName', '商品名称', record.productName),
    field('brand', '品牌', metadata.brand),
    field('productCategory', '品类', record.productCategory),
    field('priceRange', '价格区间', record.priceRange),
    field('coreSpecification', '核心规格', record.coreSpecification),
    field('seller', '店铺', metadata.seller),
    field('deliveryPromise', '配送信息', metadata.deliveryPromise),
    ...COMMERCE_CANDIDATE_FIELDS.slice(4).map(([key, label]) => field(key, label, record[key])),
  ]);
};

const commerceSummary = (nodeStatus: EffectExtractionNodeStatus): string => {
  switch (nodeStatus) {
    case 'FAILED':
      return '商品页面暂时无法读取，已继续使用其他资料';
    case 'PARTIAL':
      return '已提取部分商品信息';
    case 'SUCCEEDED':
      return '已提取商品页中的产品信息';
    case 'SKIPPED':
      return '未提供商品链接，无需解析';
    case 'RUNNING':
      return '正在解析商品链接';
    default:
      return '等待解析商品链接';
  }
};

const itemSources = (
  items: unknown[],
  snapshot: EffectExtractionInputSnapshot,
  fallbackStatus: EffectExtractionNodeStatus,
  excludedMessages: string[] = [],
): EffectExtractionNodeDetailSource[] => {
  const materials = new Map(snapshot.materials.map((material) => [material.id, material]));
  return items.slice(0, 50).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const material = typeof raw.sourceId === 'string' ? materials.get(raw.sourceId) : undefined;
    return [
      {
        name: fileName(material?.originalFileName),
        status: status(raw.status, fallbackStatus),
        ...(material ? { media: materialMedia(snapshot, material) } : {}),
        fields: candidateFields(raw.candidate),
        warnings: safeWarnings(raw.warning ? [raw.warning] : [], excludedMessages),
      },
    ];
  });
};

const materialCount = (snapshot: EffectExtractionInputSnapshot, type: string): number =>
  snapshot.materials.filter((material) => material.type === type).length;

const snapshotSummary = (snapshot: EffectExtractionInputSnapshot): string => {
  const commerceUrl = visibleCommerceUrl(snapshot.product.commerceUrl);
  const counts = [
    ['图片', '份', materialCount(snapshot, 'PRODUCT_IMAGE')],
    ['文档', '份', materialCount(snapshot, 'PRODUCT_DOCUMENT')],
    ['品牌规范', '份', materialCount(snapshot, 'BRAND_GUIDELINE')],
    ['参考视频', '份', materialCount(snapshot, 'REFERENCE_VIDEO')],
    ['电商链接', '个', commerceUrl ? 1 : 0],
  ] as const;
  const parts = counts
    .filter(([, , count]) => count > 0)
    .map(([label, unit, count]) => `${count} ${unit}${label}`);
  const total = snapshot.materials.length + Number(Boolean(commerceUrl));
  return total ? `本次共使用 ${total} 项资料：${parts.join('、')}` : '本次没有可用资料';
};

const snapshotSources = (
  snapshot: EffectExtractionInputSnapshot,
  nodeStatus: EffectExtractionNodeStatus,
): EffectExtractionNodeDetailSource[] => {
  const sourceStatus: EffectExtractionNodeStatus =
    nodeStatus === 'PENDING' || nodeStatus === 'RUNNING' ? nodeStatus : 'SUCCEEDED';
  const materialSources: EffectExtractionNodeDetailSource[] = snapshot.materials
    .slice(0, 50)
    .map((material) => ({
      name: fileName(material.originalFileName),
      status: sourceStatus,
      media: materialMedia(snapshot, material),
      fields: [],
      warnings: [],
    }));
  const commerceUrl = visibleCommerceUrl(snapshot.product.commerceUrl);
  return commerceUrl
    ? [
        ...materialSources,
        {
          name: commerceUrl,
          status: sourceStatus,
          media: {
            kind: 'LINK',
            typeLabel: '电商链接',
            previewUrl: null,
            sizeBytes: null,
          },
          fields: [],
          warnings: [],
        },
      ]
    : materialSources;
};

export const presentExtractionNodeDetail = (
  record: ExtractionNodeDetailRecord,
  nodeId: EffectExtractionNodeId,
  execution: EffectExtractionNodeExecution,
): EffectExtractionNodeDetail => {
  const snapshot = record.inputSnapshot as EffectExtractionInputSnapshot;
  const branch = record.branches?.find((item) => item.branch === nodeId);
  const output = payload(branch?.structuredOutput);
  const errorMessage = execution.errorMessage ? publicText(execution.errorMessage) : null;
  const warningMessages = new Set<string>();
  const base = {
    nodeId,
    status: execution.status,
    warnings: execution.warnings.flatMap((warning) => {
      const message = publicText(warning.message, 1000);
      if (!message || message === errorMessage || warningMessages.has(message)) return [];
      warningMessages.add(message);
      return [
        {
          code: publicText(warning.code, 120),
          message,
          branch: warning.branch,
        },
      ];
    }),
    errorMessage,
    updatedAt: (branch?.updatedAt ?? record.updatedAt).toISOString(),
  };

  if (nodeId === 'LOAD_AND_SNAPSHOT') {
    return {
      ...base,
      summary: snapshotSummary(snapshot),
      fields: [],
      sources: snapshotSources(snapshot, execution.status),
    };
  }

  if (nodeId === 'DOCUMENT' || nodeId === 'IMAGE') {
    const sources = itemSources(
      output.items,
      snapshot,
      execution.status,
      errorMessage ? [errorMessage] : [],
    );
    const label = nodeId === 'DOCUMENT' ? '文档' : '图片';
    return {
      ...base,
      summary: branch ? `已处理 ${sources.length} 份${label}资料` : `等待处理${label}资料`,
      fields: [],
      sources,
    };
  }

  if (nodeId === 'COMMERCE') {
    const visibleFields = commerceFields(
      output.candidate,
      output.metadata,
      snapshot.product.commerceUrl,
    );
    return {
      ...base,
      warnings: execution.status === 'SKIPPED' ? [] : base.warnings,
      summary: commerceSummary(execution.status),
      fields: visibleFields,
      sources: [],
    };
  }

  if (nodeId === 'FORM') {
    const config = snapshot.globalVideoConfig ?? snapshot.product.effectiveConfig;
    return {
      ...base,
      summary: branch ? '已读取导入节点的全局视频配置' : '等待读取全局视频配置',
      fields: fields([
        field('durationSeconds', '视频时长', `${config.durationSeconds} 秒`, '全局配置'),
        field('aspectRatio', '画幅比例', config.aspectRatio, '全局配置'),
        field('styleTone', '风格基调', config.styleTone, '全局配置'),
        field('deliveryChannel', '投放渠道', config.deliveryChannel, '全局配置'),
        field('disabledElements', '禁用元素', config.disabledElements, '全局配置', true),
      ]),
      sources: [],
    };
  }

  if (nodeId === 'FUSION') {
    return {
      ...base,
      summary: branch ? '已合并来自不同资料的产品信息' : '等待合并产品信息',
      fields: candidateFields(output.candidate, output.metadata.provenance, true),
      sources: [],
    };
  }

  const result = record.result;
  return {
    ...base,
    summary: result ? '产品信息卡已经生成，可以继续编辑' : '等待生成产品信息卡',
    fields: [
      ...candidateFields(result?.draftResult ?? output.candidate, result?.provenance, true),
      ...fields([
        field('revision', '结果修订号', result?.revision),
        field('savedAt', '最近保存时间', result?.savedAt?.toISOString()),
      ]),
    ],
    sources: [],
    updatedAt: (result?.updatedAt ?? branch?.updatedAt ?? record.updatedAt).toISOString(),
  };
};
