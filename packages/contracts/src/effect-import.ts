/**
 * Shared contracts for effect workflow step 01 (source package import).
 *
 * Dates are serialized as ISO-8601 strings and every persisted business entity
 * carries its projectId so callers cannot accidentally lose project scope.
 */

export const EFFECT_IMPORT_API_BASE =
  '/api/projects/:projectId/workflows/effect/source-import' as const;

export const EFFECT_IMPORT_MODES = ['SINGLE', 'BATCH'] as const;
export type EffectImportMode = (typeof EFFECT_IMPORT_MODES)[number];

export const EFFECT_IMPORT_DRAFT_STATUSES = ['DRAFT', 'VALID', 'COMPLETED'] as const;
export type EffectImportDraftStatus = (typeof EFFECT_IMPORT_DRAFT_STATUSES)[number];

export const EFFECT_IMPORT_NODE_KEYS = ['SOURCE_IMPORT', 'AI_INFO_EXTRACTION'] as const;
export type EffectImportNodeKey = (typeof EFFECT_IMPORT_NODE_KEYS)[number];

export const EFFECT_IMPORT_NODE_STATUSES = ['LOCKED', 'CURRENT', 'AVAILABLE', 'COMPLETED'] as const;
export type EffectImportNodeStatus = (typeof EFFECT_IMPORT_NODE_STATUSES)[number];

export const EFFECT_IMPORT_MATERIAL_TYPES = [
  'PRODUCT_IMAGE',
  'PRODUCT_DOCUMENT',
  'BRAND_GUIDELINE',
  'REFERENCE_VIDEO',
] as const;
export type EffectImportMaterialType = (typeof EFFECT_IMPORT_MATERIAL_TYPES)[number];

export const EFFECT_IMPORT_MATERIAL_TYPE_LABELS: Record<EffectImportMaterialType, string> = {
  PRODUCT_IMAGE: '商品图片',
  PRODUCT_DOCUMENT: '产品文档',
  BRAND_GUIDELINE: '品牌规范',
  REFERENCE_VIDEO: '参考视频',
};

export const EFFECT_IMPORT_MATERIAL_STATUSES = ['MISSING', 'UPLOADING', 'READY', 'FAILED'] as const;
export type EffectImportMaterialStatus = (typeof EFFECT_IMPORT_MATERIAL_STATUSES)[number];

export const EFFECT_IMPORT_FAILURE_DISPOSITIONS = ['RETRYABLE', 'REQUIRES_NEW_FILE'] as const;
export type EffectImportFailureDisposition = (typeof EFFECT_IMPORT_FAILURE_DISPOSITIONS)[number];

export const EFFECT_IMPORT_ASPECT_RATIOS = [
  '9:16',
  '16:9',
  '1:1',
  '4:3',
  '3:4',
  '2:3',
  '21:9',
] as const;
export const EFFECT_IMPORT_DURATION_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;
export const EFFECT_IMPORT_RESOLUTIONS = ['720P', '1080P', '2K', '4K'] as const;
export const EFFECT_IMPORT_FRAME_RATE_OPTIONS = [23.976, 24, 25, 30, 50, 60] as const;
export const EFFECT_IMPORT_SUBTITLE_STRATEGIES = [
  '跟随口播',
  '全程字幕',
  '重点词高亮',
  '仅 CTA',
  '无字幕',
] as const;
export const EFFECT_IMPORT_VOICEOVER_STRATEGIES = [
  '无口播',
  'AI 男声',
  'AI 女声',
  '真人口播',
  '仅文字与音效',
] as const;
export const EFFECT_IMPORT_BGM_STRATEGIES = [
  '自动匹配',
  '品牌 BGM',
  '轻快',
  '高级质感',
  '无 BGM',
] as const;
export const EFFECT_IMPORT_STYLE_TONES = [
  '清爽明亮',
  '高级质感',
  '自然生活',
  '活力年轻',
  '专业可信',
] as const;
export const EFFECT_IMPORT_DELIVERY_CHANNELS = [
  '抖音',
  '快手',
  '小红书',
  '视频号',
  '淘宝',
  '京东',
] as const;

/** Values are open strings/numbers so custom combobox entries survive round trips. */
export type EffectVideoConfig = {
  aspectRatio: string;
  durationSeconds: number;
  resolution: string;
  frameRate: number;
  subtitleStrategy: string;
  voiceoverStrategy: string;
  bgmStrategy: string;
  styleTone: string;
  deliveryChannel: string;
  disabledElements: string[];
};

export type EffectVideoConfigOverride = Partial<EffectVideoConfig>;

export const DEFAULT_EFFECT_VIDEO_CONFIG: EffectVideoConfig = {
  aspectRatio: '9:16',
  durationSeconds: 15,
  resolution: '1080P',
  frameRate: 30,
  subtitleStrategy: '跟随口播',
  voiceoverStrategy: 'AI 女声',
  bgmStrategy: '自动匹配',
  styleTone: '清爽明亮',
  deliveryChannel: '抖音',
  disabledElements: [],
};

export const EFFECT_IMPORT_LIMITS = {
  maxBatchProducts: 100,
  maxManifestBytes: 10 * 1024 * 1024,
  maxManifestRows: 100,
  maxImageBytes: 50 * 1024 * 1024,
  maxDocumentBytes: 100 * 1024 * 1024,
  maxReferenceVideoBytes: 512 * 1024 * 1024,
  maxDisabledElements: 50,
  minDurationSeconds: 1,
  maxDurationSeconds: 300,
  minFrameRate: 1,
  maxFrameRate: 120,
  manifestPreviewTtlHours: 24,
} as const;

export const EFFECT_IMPORT_VALIDATION_SEVERITIES = ['ERROR', 'WARNING'] as const;
export type EffectImportValidationSeverity = (typeof EFFECT_IMPORT_VALIDATION_SEVERITIES)[number];

export const EFFECT_IMPORT_VALIDATION_SCOPES = [
  'DRAFT',
  'PRODUCT',
  'MATERIAL',
  'MANIFEST_ROW',
  'MANIFEST_FILE',
] as const;
export type EffectImportValidationScope = (typeof EFFECT_IMPORT_VALIDATION_SCOPES)[number];

export const EFFECT_IMPORT_VALIDATION_CODES = [
  'REQUIRED_FIELD',
  'FIELD_TOO_LONG',
  'DUPLICATE_SKU',
  'INVALID_COMMERCE_URL',
  'INVALID_VIDEO_CONFIG',
  'PRODUCT_IMAGE_REQUIRED',
  'MATERIAL_MISSING',
  'MATERIAL_UPLOADING',
  'MATERIAL_FAILED',
  'PRODUCT_LIMIT_EXCEEDED',
  'MANIFEST_HEADER_MISSING',
  'MANIFEST_ROW_LIMIT_EXCEEDED',
  'MANIFEST_FORMAT_UNSUPPORTED',
  'MANIFEST_FORMULA_UNSUPPORTED',
  'FILE_MATCH_NOT_FOUND',
  'FILE_MATCH_AMBIGUOUS',
  'FILE_TYPE_UNSUPPORTED',
  'FILE_TOO_LARGE',
] as const;
export type EffectImportValidationCode = (typeof EFFECT_IMPORT_VALIDATION_CODES)[number];

export type EffectImportValidationIssue = {
  code: EffectImportValidationCode;
  severity: EffectImportValidationSeverity;
  scope: EffectImportValidationScope;
  message: string;
  field: string | null;
  productId: string | null;
  materialId: string | null;
  manifestRowNumber: number | null;
  fileName: string | null;
};

export type EffectImportValidationResult = {
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
  revision: number;
  validatedRevision: number | null;
  valid: boolean;
  issues: EffectImportValidationIssue[];
  validatedAt: string;
};

export type EffectImportMaterial = {
  id: string;
  projectId: string;
  productId: string;
  type: EffectImportMaterialType;
  status: EffectImportMaterialStatus;
  expectedFileName: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  contentUrl: string | null;
  failureDisposition: EffectImportFailureDisposition | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type EffectImportProduct = {
  id: string;
  projectId: string;
  draftId: string;
  name: string;
  category: string;
  sku: string;
  normalizedSku: string;
  commerceUrl: string | null;
  configOverride: EffectVideoConfigOverride;
  effectiveConfig: EffectVideoConfig;
  sortOrder: number;
  sourceManifestImportId: string | null;
  sourceManifestRowNumber: number | null;
  materials: EffectImportMaterial[];
  createdAt: string;
  updatedAt: string;
};

export type EffectImportPublishSummary = {
  publishedAt: string;
  assetCount: number;
  assetVersionCount: number;
};

export type EffectImportDraftSummary = {
  id: string;
  projectId: string;
  mode: EffectImportMode;
  status: EffectImportDraftStatus;
  revision: number;
  validatedRevision: number | null;
  productCount: number;
  issueCount: number;
  completedAt: string | null;
  lastPublish: EffectImportPublishSummary | null;
  updatedAt: string;
};

export type EffectImportDraft = EffectImportDraftSummary & {
  globalConfig: EffectVideoConfig;
  validationIssues: EffectImportValidationIssue[];
  products: EffectImportProduct[];
  createdAt: string;
};

export type EffectImportWorkspace = {
  id: string;
  projectId: string;
  currentMode: EffectImportMode;
  revision: number;
  drafts: Record<EffectImportMode, EffectImportDraftSummary>;
  currentNode: EffectImportNodeKey;
  nodeStatuses: Record<EffectImportNodeKey, EffectImportNodeStatus>;
  createdAt: string;
  updatedAt: string;
};

export type GetEffectImportWorkspaceData = {
  workspace: EffectImportWorkspace;
  defaultConfig: EffectVideoConfig;
};

export type SwitchEffectImportModeRequest = {
  mode: EffectImportMode;
  expectedRevision: number;
};

export type SwitchEffectImportModeData = {
  workspace: EffectImportWorkspace;
  draft: EffectImportDraft;
};

export type UpdateEffectImportDraftRequest = {
  globalConfig: EffectVideoConfig;
  expectedRevision: number;
};

export type UpdateEffectImportDraftData = {
  draft: EffectImportDraft;
};

export type EffectImportProductListQuery = {
  keyword?: string | undefined;
  category?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
};

export type EffectImportPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type EffectImportProductListData = {
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
  revision: number;
  items: EffectImportProduct[];
  pagination: EffectImportPagination;
  categoryOptions: string[];
};

export type CreateEffectImportProductRequest = {
  name: string;
  category: string;
  commerceUrl?: string | null | undefined;
  configOverride?: EffectVideoConfigOverride | undefined;
  expectedRevision: number;
};

export type UpdateEffectImportProductRequest = {
  name?: string | undefined;
  category?: string | undefined;
  commerceUrl?: string | null | undefined;
  configOverride?: EffectVideoConfigOverride | undefined;
  expectedRevision: number;
};

export type EffectImportProductMutationData = {
  product: EffectImportProduct;
  revision: number;
};

export type EffectImportDeleteData = {
  deleted: true;
  revision: number;
};

export type BatchDeleteEffectImportProductsRequest = {
  productIds: string[];
  expectedRevision: number;
};

export type BatchDeleteEffectImportProductsData = {
  deletedProductIds: string[];
  revision: number;
};

export type BatchRetryEffectImportProductsRequest = {
  productIds: string[];
  expectedRevision: number;
};

export type EffectImportRetryResult = {
  materialId: string;
  productId: string;
  status: 'RETRYING' | 'REQUIRES_NEW_FILE' | 'NOT_RETRYABLE';
};

export type BatchRetryEffectImportProductsData = {
  results: EffectImportRetryResult[];
  revision: number;
};

export type ValidateEffectImportLinkRequest = {
  commerceUrl: string;
};

export type ValidateEffectImportLinkData = {
  valid: boolean;
  normalizedUrl: string | null;
  issue: EffectImportValidationIssue | null;
};

/** Metadata fields sent alongside multipart file content. */
export type CreateEffectImportMaterialRequest = {
  type: EffectImportMaterialType;
  expectedRevision: number;
  expectedFileName?: string | undefined;
};

/** Metadata fields sent alongside multipart replacement file content. */
export type ReplaceEffectImportMaterialContentRequest = {
  expectedRevision: number;
};

export type EffectImportMaterialMutationData = {
  material: EffectImportMaterial;
  revision: number;
};

export const EFFECT_MANIFEST_FORMATS = ['csv', 'xlsx'] as const;
export type EffectManifestFormat = (typeof EFFECT_MANIFEST_FORMATS)[number];

export const EFFECT_MANIFEST_COLUMNS = [
  '产品名称',
  '品类',
  '电商链接',
  '商品图片',
  '产品文档',
  '品牌规范',
  '参考视频',
] as const;
export type EffectManifestColumn = (typeof EFFECT_MANIFEST_COLUMNS)[number];

export const EFFECT_MANIFEST_IMPORT_STATUSES = [
  'PREVIEW',
  'COMMITTED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type EffectManifestImportStatus = (typeof EFFECT_MANIFEST_IMPORT_STATUSES)[number];

export const EFFECT_MANIFEST_FILE_MATCH_STATUSES = ['MATCHED', 'MISSING', 'AMBIGUOUS'] as const;
export type EffectManifestFileMatchStatus = (typeof EFFECT_MANIFEST_FILE_MATCH_STATUSES)[number];

export type EffectManifestMaterialReference = {
  type: EffectImportMaterialType;
  expectedFileName: string;
  matchStatus: EffectManifestFileMatchStatus;
  stagedFileIds: string[];
};

export type EffectManifestPreviewRow = {
  rowNumber: number;
  name: string;
  category: string;
  sku: string;
  normalizedSku: string;
  commerceUrl: string | null;
  materialReferences: EffectManifestMaterialReference[];
  issues: EffectImportValidationIssue[];
  valid: boolean;
};

export type EffectManifestStagedFile = {
  id: string;
  projectId: string;
  manifestImportId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  matchedRowNumbers: number[];
  matchedMaterialType: EffectImportMaterialType | null;
  matchStatus: EffectManifestFileMatchStatus;
};

/** Metadata fields sent alongside multipart manifest and optional files[]. */
export type PreviewEffectManifestRequest = {
  expectedRevision: number;
  idempotencyKey?: string | undefined;
};

export type PreviewEffectManifestData = {
  id: string;
  projectId: string;
  draftId: string;
  status: EffectManifestImportStatus;
  format: EffectManifestFormat;
  originalFileName: string;
  rowCount: number;
  rows: EffectManifestPreviewRow[];
  stagedFiles: EffectManifestStagedFile[];
  issues: EffectImportValidationIssue[];
  expiresAt: string;
  createdAt: string;
};

export type CommitEffectManifestRequest = {
  expectedRevision: number;
  idempotencyKey: string;
};

export type CommitEffectManifestData = {
  manifestImportId: string;
  status: 'COMMITTED';
  productIds: string[];
  createdProductCount: number;
  revision: number;
};

export type CancelEffectManifestData = {
  manifestImportId: string;
  status: 'CANCELLED';
  deletedStagedFileCount: number;
  revision: number;
};

export type EffectManifestTemplateData = {
  format: EffectManifestFormat;
  fileName: string;
  contentType: string;
};

export type ValidateEffectImportDraftRequest = {
  expectedRevision: number;
};

export type ValidateEffectImportDraftData = {
  draft: EffectImportDraft;
  validation: EffectImportValidationResult;
};

export type PublishEffectImportDraftRequest = {
  expectedRevision: number;
  /** Stable for retries of one publish click; generate a new key for an intentional new version. */
  idempotencyKey: string;
};

export type EffectImportPublishedAsset = {
  assetId: string;
  assetVersionId: string;
  version: number;
  productId: string;
  materialId: string | null;
  kind: 'PRODUCT_METADATA' | 'VIDEO_CONFIG' | 'MATERIAL';
};

export type PublishEffectImportDraftData = {
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
  revision: number;
  publishedAssets: EffectImportPublishedAsset[];
  summary: EffectImportPublishSummary;
};

export type AdvanceEffectImportDraftRequest = {
  expectedRevision: number;
};

export type AdvanceEffectImportDraftData = {
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
  revision: number;
  completedNode: 'SOURCE_IMPORT';
  nextNode: 'AI_INFO_EXTRACTION';
  nextNodeStatus: 'AVAILABLE';
};

/** Normalize SKU values for comparisons within a single draft. */
export function normalizeEffectImportSku(value: string): string {
  return value.trim().normalize('NFKC').toUpperCase();
}

/** Resolve an effective per-product config without mutating either input. */
export function mergeEffectVideoConfig(
  globalConfig: EffectVideoConfig,
  override: EffectVideoConfigOverride,
): EffectVideoConfig {
  return {
    ...globalConfig,
    ...override,
    disabledElements: [...(override.disabledElements ?? globalConfig.disabledElements)],
  };
}
