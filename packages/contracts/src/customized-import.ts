import type { WorkflowRun, EffectWorkflowBranchNodeStatus } from './workflow-working';

/** Five stages; video production is the final node. */
export const CUSTOMIZED_WORKFLOW_NODES = [
  'SOURCE_IMPORT',
  'INFORMATION_EXTRACTION',
  'STORYBOARD',
  'SHOT_PROMPT',
  'SHOT_RENDER',
] as const;
export type CustomizedWorkflowNodeId = (typeof CUSTOMIZED_WORKFLOW_NODES)[number];

/** Read-only projection of historical navigation; never rewrites saved artifacts. */
export const customizedWorkflowNodeId = (value: unknown): CustomizedWorkflowNodeId | null => {
  if (value === 'VISUAL_ASSETS' || value === 'DELIVERY') return 'SHOT_RENDER';
  return CUSTOMIZED_WORKFLOW_NODES.find((node) => node === value) ?? null;
};

export const CUSTOMIZED_MATERIAL_CATEGORIES = [
  'BRIEF',
  'PRODUCT',
  'VISUAL_REFERENCE',
  'CHARACTER',
  'BRAND',
  'REFERENCE',
] as const;
export type CustomizedMaterialCategory = (typeof CUSTOMIZED_MATERIAL_CATEGORIES)[number];
export type CustomizedImportSection = 'BRIEF' | 'VISUAL_REFERENCE';
export const CUSTOMIZED_IMPORT_LIMITS = {
  maxDocumentBytes: 100 * 1024 * 1024,
  maxImageBytes: 100 * 1024 * 1024,
} as const;
export type UploadCustomizedMaterialRequest = { section: CustomizedImportSection };
export const CUSTOMIZED_MATERIAL_CATEGORY_LABELS: Record<CustomizedMaterialCategory, string> = {
  BRIEF: '视频创作简报',
  PRODUCT: '产品资料',
  VISUAL_REFERENCE: '品牌素材',
  CHARACTER: '人物与人设',
  BRAND: '品牌资料',
  REFERENCE: '历史参考资料',
};
/** New uploads describe supplied brand elements; generated product assets belong downstream. */
export const CUSTOMIZED_BRAND_IMAGE_USAGES = [
  'LOGO',
  'WORDMARK',
  'BRAND_GRAPHIC',
  'BRAND_IP',
  'PACKAGING',
] as const;
/** Legacy usages remain valid to preserve pinned files and confirmed source packages. */
export const CUSTOMIZED_IMAGE_USAGES = [
  ...CUSTOMIZED_BRAND_IMAGE_USAGES,
  'PRODUCT',
  'PERSON',
  'SCENE',
  'STYLE',
  'OTHER',
] as const;
export type CustomizedImageUsage = (typeof CUSTOMIZED_IMAGE_USAGES)[number];
export const CUSTOMIZED_IMAGE_USAGE_LABELS: Record<CustomizedImageUsage, string> = {
  LOGO: '品牌 Logo',
  WORDMARK: '品牌标准字',
  BRAND_GRAPHIC: '品牌图案',
  BRAND_IP: '品牌 IP',
  PACKAGING: '包装平面图',
  PRODUCT: '产品参考',
  PERSON: '人物参考',
  SCENE: '场景参考',
  STYLE: '风格参考',
  OTHER: '其他参考',
};
// Retained only to decode historical v1 drafts.
export const CUSTOMIZED_ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4'] as const;
export type CustomizedImportMaterial = {
  assetId: string;
  assetVersion: number;
  category: CustomizedMaterialCategory;
  imageUsage?: CustomizedImageUsage | undefined;
};
/** Editing draft only; confirmation submits requirements and optional images together. */
export type CustomizedImportDraftState = {
  schemaVersion: 3;
  /** Historical text retained for recovery/export; new packages are imported as documents. */
  requirements: string;
  materials: CustomizedImportMaterial[];
};
export const emptyCustomizedImportDraft = (): CustomizedImportDraftState => ({
  schemaVersion: 3,
  requirements: '',
  materials: [],
});
export const restoreCustomizedImportDraft = (state: unknown): CustomizedImportDraftState => {
  if (state === null || state === undefined) return emptyCustomizedImportDraft();
  const fail = (): never => {
    throw new Error('资料草稿格式不正确，请保留原资料并联系管理员');
  };
  if (!state || typeof state !== 'object' || Array.isArray(state)) return fail();
  const value = state as Record<string, unknown>;
  if (
    !Array.isArray(value.materials) ||
    !value.materials.every(
      (item) =>
        item &&
        typeof item.assetId === 'string' &&
        item.assetId.length > 0 &&
        Number.isInteger(item.assetVersion) &&
        item.assetVersion > 0 &&
        CUSTOMIZED_MATERIAL_CATEGORIES.includes(item.category) &&
        (item.imageUsage === undefined || CUSTOMIZED_IMAGE_USAGES.includes(item.imageUsage)),
    )
  )
    return fail();
  const materials = structuredClone(value.materials) as CustomizedImportMaterial[];
  if (value.schemaVersion === 3) {
    if (typeof value.requirements !== 'string') return fail();
    return { schemaVersion: 3, requirements: value.requirements, materials };
  }
  if (value.schemaVersion === 2) {
    if (
      typeof value.customerRequirements !== 'string' ||
      typeof value.productInformation !== 'string'
    )
      return fail();
    return {
      schemaVersion: 3,
      requirements: [
        value.customerRequirements.trim(),
        value.productInformation.trim() ? `产品资料：\n${value.productInformation.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      materials,
    };
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.coreMessage !== 'string' ||
    typeof value.brandTone !== 'string' ||
    !Array.isArray(value.disabledElements) ||
    !value.disabledElements.every((item) => typeof item === 'string') ||
    !Number.isInteger(value.durationSeconds) ||
    (value.durationSeconds as number) < 5 ||
    (value.durationSeconds as number) > 600 ||
    !CUSTOMIZED_ASPECT_RATIOS.includes(
      value.aspectRatio as (typeof CUSTOMIZED_ASPECT_RATIOS)[number],
    )
  )
    return fail();
  const hasLegacyContent =
    value.coreMessage.trim() ||
    value.brandTone.trim() ||
    value.disabledElements.length ||
    materials.length ||
    value.durationSeconds !== 60 ||
    value.aspectRatio !== '9:16';
  const requirements = hasLegacyContent
    ? [
        value.coreMessage.trim(),
        value.brandTone.trim() ? `品牌调性：${value.brandTone.trim()}` : '',
        value.disabledElements.length ? `禁止元素：${value.disabledElements.join('、')}` : '',
        `视频总时长：${value.durationSeconds} 秒`,
        `画幅：${value.aspectRatio}`,
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  return {
    schemaVersion: 3,
    requirements,
    materials,
  };
};
export const customizedMaterialSection = (
  category: CustomizedMaterialCategory,
  isImage = false,
): CustomizedImportSection =>
  isImage ? 'VISUAL_REFERENCE' : category === 'VISUAL_REFERENCE' ? 'VISUAL_REFERENCE' : 'BRIEF';
/** Same canonical projection for current drafts and historical baselines; no writes on read. */
export const normalizeCustomizedImportDraft = (
  state: unknown,
  imageAssetIds: ReadonlySet<string> = new Set(),
): CustomizedImportDraftState => {
  const draft = restoreCustomizedImportDraft(state);
  return {
    schemaVersion: 3,
    requirements: draft.requirements.trim(),
    materials: draft.materials
      .map((item) => {
        const category = customizedMaterialSection(item.category, imageAssetIds.has(item.assetId));
        const imageUsage =
          item.imageUsage ??
          (imageAssetIds.has(item.assetId)
            ? (
                {
                  PRODUCT: 'PRODUCT',
                  CHARACTER: 'PERSON',
                  BRAND: 'STYLE',
                  REFERENCE: 'STYLE',
                } as const
              )[item.category as 'PRODUCT' | 'CHARACTER' | 'BRAND' | 'REFERENCE']
            : undefined);
        return {
          assetId: item.assetId,
          assetVersion: item.assetVersion,
          category,
          ...(category === 'VISUAL_REFERENCE' && imageUsage ? { imageUsage } : {}),
        };
      })
      .sort((a, b) => a.assetId.localeCompare(b.assetId)),
  };
};
export const validateCustomizedImportDraft = (draft: CustomizedImportDraftState): string[] => {
  const errors: string[] = [];
  if (!draft.materials.some((item) => customizedMaterialSection(item.category) === 'BRIEF'))
    errors.push('请上传至少一份视频创作简报文档');
  if (
    draft.materials.some(
      (item) => item.imageUsage !== undefined && !CUSTOMIZED_IMAGE_USAGES.includes(item.imageUsage),
    )
  )
    errors.push('请选择有效的图片用途');
  return errors;
};

export const CUSTOMIZED_SOURCE_ARTIFACT_KEY = 'customized-source-package';
export type CustomizedWorkflowBranch = {
  workflowRunId: string;
  parentWorkflowRunId: string | null;
  forkNodeId: CustomizedWorkflowNodeId | null;
  label: string;
  currentNodeId: string | null;
  createdAt: string;
  isActive: boolean;
  nodes: {
    nodeId: CustomizedWorkflowNodeId;
    status: EffectWorkflowBranchNodeStatus;
    artifactCount: number;
    revision: number | null;
    artifactCreatedAt: string | null;
  }[];
};
export type CustomizedWorkflowBranchTreeData = {
  projectId: string;
  activeWorkflowRunId: string | null;
  branches: CustomizedWorkflowBranch[];
};
export type SaveCustomizedSourceVersionRequest = { expectedRevision: number };
export type CustomizedWorkflowVersionData = {
  run: WorkflowRun;
  activeWorkflowRunId: string;
  createdBranch: boolean;
  unchanged: boolean;
};
