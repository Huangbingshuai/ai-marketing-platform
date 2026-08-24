export const ASSET_WORKFLOWS = ['EFFECT', 'CUSTOMIZED', 'FISSION'] as const;
export type AssetWorkflow = (typeof ASSET_WORKFLOWS)[number];

export const ASSET_WORKFLOW_LABELS: Record<AssetWorkflow, string> = {
  EFFECT: '效果类',
  CUSTOMIZED: '定制类',
  FISSION: '裂变类',
};

export const ASSET_WORKFLOW_SPACES = [
  'EFFECT',
  'CUSTOMIZED_PROJECT',
  'CUSTOMIZED_VOICE_LIBRARY',
  'FISSION_CLONE',
  'FISSION_AVATAR',
  'FISSION_LOCAL_REPLACE',
] as const;
export type AssetWorkflowSpace = (typeof ASSET_WORKFLOW_SPACES)[number];
export const ASSET_WORKFLOW_SPACE_LABELS: Record<AssetWorkflowSpace, string> = {
  EFFECT: '效果类项目',
  CUSTOMIZED_PROJECT: '定制项目',
  CUSTOMIZED_VOICE_LIBRARY: '音色库',
  FISSION_CLONE: '爆款视频项目',
  FISSION_AVATAR: '数字人库',
  FISSION_LOCAL_REPLACE: '局部属性变更项目',
};

export const ASSET_DIRECTORIES = [
  'SOURCE_MATERIALS',
  'SOURCE_VIDEOS',
  'SCRIPTS',
  'PROMPTS',
  'VISUAL_ASSETS',
  'AUDIO_ASSETS',
  'VIDEO_MATERIALS',
  'SUBTITLES',
  'INSIGHTS',
  'EDITING_PROJECTS',
  'REPLACEMENT_PLANS',
  'REPLACEMENT_CONFIGS',
  'REPLACEMENT_REFERENCES',
  'ARCHIVES',
  'FINAL_VIDEOS',
  'REPORTS_DELIVERABLES',
] as const;
export type AssetDirectory = (typeof ASSET_DIRECTORIES)[number];
export const ASSET_DIRECTORY_LABELS: Record<AssetDirectory, string> = {
  SOURCE_MATERIALS: '原始资料',
  SOURCE_VIDEOS: '原始成片',
  SCRIPTS: '脚本',
  PROMPTS: 'Prompt',
  VISUAL_ASSETS: '视觉资产',
  AUDIO_ASSETS: '音频资产',
  VIDEO_MATERIALS: '视频素材',
  SUBTITLES: '字幕资产',
  INSIGHTS: '提炼结果',
  EDITING_PROJECTS: '剪辑工程',
  REPLACEMENT_PLANS: '替换方案',
  REPLACEMENT_CONFIGS: '替换配置',
  REPLACEMENT_REFERENCES: '替换素材',
  ARCHIVES: '交付包',
  FINAL_VIDEOS: '成片',
  REPORTS_DELIVERABLES: '报告与交付清单',
};

export const ASSET_TYPES = [
  'DIGITAL_HUMAN_CHARACTER',
  'AVATAR_REFERENCE',
  'PERSON_ASSET',
  'PRODUCT_ASSET',
  'SCENE_BACKGROUND',
  'VISUAL_ASSET',
  'GENERIC_VIDEO',
  'REFERENCE_VIDEO',
  'SOURCE_VIDEO',
  'VIDEO_MATERIAL',
  'FINAL_VIDEO',
  'VOICE_AUDIO',
  'VOICE_PROFILE',
  'SUBTITLE',
  'PROMPT',
  'SCRIPT_COPY',
  'STORYBOARD_SCRIPT',
  'SOURCE_MATERIAL',
  'VIDEO_CONFIG',
  'INSIGHT_RESULT',
  'MIX_TEMPLATE',
  'TIMELINE_PROJECT',
  'EDITING_PROJECT',
  'ARCHIVE_DELIVERABLE',
  'REPLACEMENT_MAPPING',
  'REPLACEMENT_CONFIGURATION',
  'REFERENCE_SET',
  'DELIVERY_MANIFEST',
  'ANALYSIS_QUALITY_REPORT',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  DIGITAL_HUMAN_CHARACTER: '数字人与人物',
  AVATAR_REFERENCE: '数字人引用',
  PERSON_ASSET: '人物资产',
  PRODUCT_ASSET: '产品资产',
  SCENE_BACKGROUND: '场景与背景',
  VISUAL_ASSET: '视觉资产',
  GENERIC_VIDEO: '视频资产',
  REFERENCE_VIDEO: '爆款参考视频',
  SOURCE_VIDEO: '待替换原成片',
  VIDEO_MATERIAL: '视频素材',
  FINAL_VIDEO: '最终成片',
  VOICE_AUDIO: '口播与音频',
  VOICE_PROFILE: '音色配置',
  SUBTITLE: '字幕资产',
  PROMPT: 'Prompt',
  SCRIPT_COPY: '脚本与文案',
  STORYBOARD_SCRIPT: '分镜脚本',
  SOURCE_MATERIAL: '原始资料',
  VIDEO_CONFIG: '视频配置',
  INSIGHT_RESULT: '提炼结果',
  MIX_TEMPLATE: '混剪模板',
  TIMELINE_PROJECT: '时间轴工程',
  EDITING_PROJECT: '剪辑工程',
  ARCHIVE_DELIVERABLE: '交付包',
  REPLACEMENT_MAPPING: '映射与替换方案',
  REPLACEMENT_CONFIGURATION: '替换粒度配置',
  REFERENCE_SET: '替换素材引用',
  DELIVERY_MANIFEST: '交付清单',
  ANALYSIS_QUALITY_REPORT: '分析与质量报告',
};

export const ASSET_DIRECTORY_TYPES = {
  SOURCE_MATERIALS: ['SOURCE_MATERIAL', 'REFERENCE_VIDEO', 'VIDEO_CONFIG'],
  SOURCE_VIDEOS: ['SOURCE_VIDEO'],
  SCRIPTS: ['SCRIPT_COPY', 'STORYBOARD_SCRIPT'],
  PROMPTS: ['PROMPT'],
  VISUAL_ASSETS: [
    'DIGITAL_HUMAN_CHARACTER',
    'AVATAR_REFERENCE',
    'PERSON_ASSET',
    'PRODUCT_ASSET',
    'SCENE_BACKGROUND',
    'VISUAL_ASSET',
  ],
  AUDIO_ASSETS: ['VOICE_PROFILE', 'VOICE_AUDIO'],
  VIDEO_MATERIALS: ['GENERIC_VIDEO', 'VIDEO_MATERIAL'],
  SUBTITLES: ['SUBTITLE'],
  INSIGHTS: ['INSIGHT_RESULT'],
  EDITING_PROJECTS: ['MIX_TEMPLATE', 'TIMELINE_PROJECT', 'EDITING_PROJECT'],
  REPLACEMENT_PLANS: ['REPLACEMENT_MAPPING'],
  REPLACEMENT_CONFIGS: ['REPLACEMENT_CONFIGURATION'],
  REPLACEMENT_REFERENCES: ['REFERENCE_SET'],
  ARCHIVES: ['ARCHIVE_DELIVERABLE'],
  FINAL_VIDEOS: ['FINAL_VIDEO'],
  REPORTS_DELIVERABLES: ['ANALYSIS_QUALITY_REPORT', 'DELIVERY_MANIFEST'],
} as const satisfies Record<AssetDirectory, readonly AssetType[]>;

export const ASSET_STATUSES = [
  'AVAILABLE',
  'PENDING_REVIEW',
  'QUALITY_WARNING',
  'UNAVAILABLE',
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  AVAILABLE: '可用',
  PENDING_REVIEW: '待审核',
  QUALITY_WARNING: '质量预警',
  UNAVAILABLE: '不可用',
};
export const ASSET_PREVIEW_KINDS = ['IMAGE', 'AUDIO', 'VIDEO', 'DOWNLOAD'] as const;
export type AssetPreviewKind = (typeof ASSET_PREVIEW_KINDS)[number];

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'PROJECT_NOT_FOUND',
  'ASSET_NOT_FOUND',
  'ASSET_VERSION_NOT_FOUND',
  'SOURCE_ASSET_NOT_FOUND',
  'FILE_REQUIRED',
  'FILE_TOO_LARGE',
  'FILE_TYPE_UNSUPPORTED',
  'STORAGE_WRITE_FAILED',
  'CONFLICT',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type AssetDependency = {
  sourceProjectId: string;
  sourceAssetId: string;
  lockedVersion: number;
  name?: string | undefined;
};
export type Asset = {
  id: string;
  projectId: string;
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  tags: string[];
  notes: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  hasFile?: boolean;
  previewKind: AssetPreviewKind;
  contentUrl: string;
  downloadUrl: string;
  createdAt: string;
  updatedAt: string;
  storageWorkflow?: AssetWorkflow;
  workflowSpace?: AssetWorkflowSpace;
  status?: AssetStatus;
  qualityStatus?: AssetStatus;
  currentVersion?: number;
  assetClass?: string | null;
  businessType?: string | null;
  contentKind?: string | null;
  content?: unknown;
  businessData?: unknown;
  views?: string[];
  sourceArtifactId?: string | null;
  sourceRunId?: string | null;
  sourceNode?: string | null;
  sourceShot?: string | null;
  sourceProjectId?: string | null;
  sourceAssetId?: string | null;
  sourceVersion?: number | null;
  importedAt?: string | null;
  dependencies?: AssetDependency[];
  isSnapshot?: boolean;
  readOnly?: boolean;
  sourceCurrentVersion?: number | null;
  outdated?: boolean;
};
export type AssetVersion = {
  id: string;
  projectId: string;
  assetId: string;
  version: number;
  changeNote: string;
  status: AssetStatus;
  qualityStatus: AssetStatus;
  content: unknown;
  businessData: unknown;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

export type AssetFacetOption<T extends string> = { value: T; label: string; count: number };
export type AssetTagFacet = { value: string; count: number };
export type AssetProductFacet = { value: string; label: string; count: number };
export type AssetListFacets = {
  directories: AssetFacetOption<AssetDirectory>[];
  types: AssetFacetOption<AssetType>[];
  statuses?: AssetFacetOption<AssetStatus>[];
  tags: AssetTagFacet[];
  /** Product packages are displayed by name but filtered by their stable product id. */
  products?: AssetProductFacet[];
};
export type AssetPagination = { page: number; pageSize: number; pageCount: number };
export type AssetListData = {
  items: Asset[];
  total: number;
  facets: AssetListFacets;
  pagination?: AssetPagination;
};
export type AssetListQuery = {
  keyword?: string | undefined;
  directory?: AssetDirectory | undefined;
  type?: AssetType | undefined;
  tag?: string | undefined;
  workflow?: AssetWorkflow | undefined;
  space?: AssetWorkflowSpace | undefined;
  status?: AssetStatus | undefined;
  productId?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
};

export type CreateAssetMetadata = {
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  tags: string[];
  notes?: string | null | undefined;
  storageWorkflow?: AssetWorkflow | undefined;
  workflowSpace?: AssetWorkflowSpace | undefined;
};
export type ImportAssetsMetadata = {
  workflow: AssetWorkflow;
  space: AssetWorkflowSpace;
  type: AssetType;
};
export type UpdateAssetRequest = {
  name?: string | undefined;
  directory?: AssetDirectory | undefined;
  type?: AssetType | undefined;
  tags?: string[] | undefined;
  notes?: string | null | undefined;
  status?: AssetStatus | undefined;
  qualityStatus?: AssetStatus | undefined;
};
export type CreateAssetVersionRequest = {
  changeNote: string;
  status?: AssetStatus | undefined;
  qualityStatus?: AssetStatus | undefined;
  content?: unknown;
  businessData?: unknown;
};
export type ImportAssetSnapshotRequest = {
  sourceProjectId: string;
  sourceAssetId: string;
  sourceVersion?: number | undefined;
  targetWorkflow: AssetWorkflow;
  targetSpace: AssetWorkflowSpace;
  usageNode?: string | undefined;
};
export type BatchTagAssetsRequest = { assetIds: string[]; tags: string[] };
export type BatchArchiveAssetsRequest = { assetIds: string[] };
export type BatchAssetResult = { affected: number; assetIds: string[] };
export type StoreArtifactInput = {
  idempotencyKey: string;
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  tags?: string[] | undefined;
  notes?: string | null | undefined;
  sourceArtifactId?: string | undefined;
  sourceRunId?: string | undefined;
  sourceNode?: string | undefined;
  sourceShot?: string | undefined;
  assetClass?: string | undefined;
  businessType?: string | undefined;
  contentKind?: string | undefined;
  content?: unknown;
  businessData?: unknown;
  views?: string[] | undefined;
  dependencies?: AssetDependency[] | undefined;
};
export type StoreArtifactsRequest = {
  workflow: AssetWorkflow;
  space: AssetWorkflowSpace;
  assets: StoreArtifactInput[];
};
export type StoreArtifactsData = { items: Asset[]; created: number; versioned: number };
export type ArchiveAssetData = { id: string; archivedAt: string };
