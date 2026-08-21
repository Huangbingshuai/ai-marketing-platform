import {
  ASSET_TYPE_LABELS,
  type Asset,
  type AssetStatus,
  type AssetType,
  type AssetWorkflow,
  type AssetWorkflowSpace,
  type Project,
} from '@ai-marketing/contracts';

export type AssetCenterView = 'library' | 'current';

export const WORKFLOW_META: Record<
  AssetWorkflow,
  { label: string; icon: 'target' | 'sparkles' | 'branch' }
> = {
  EFFECT: { label: '效果类', icon: 'target' },
  CUSTOMIZED: { label: '定制类', icon: 'sparkles' },
  FISSION: { label: '裂变类', icon: 'branch' },
};

export const WORKFLOW_SPACES: Record<AssetWorkflow, readonly AssetWorkflowSpace[]> = {
  EFFECT: ['EFFECT'],
  CUSTOMIZED: ['CUSTOMIZED_PROJECT', 'CUSTOMIZED_VOICE_LIBRARY'],
  FISSION: ['FISSION_CLONE', 'FISSION_AVATAR', 'FISSION_LOCAL_REPLACE'],
};

export const GLOBAL_SPACES = new Set<AssetWorkflowSpace>([
  'CUSTOMIZED_VOICE_LIBRARY',
  'FISSION_AVATAR',
]);

export const SPACE_LABELS: Record<AssetWorkflowSpace, string> = {
  EFFECT: '效果类项目',
  CUSTOMIZED_PROJECT: '定制项目',
  CUSTOMIZED_VOICE_LIBRARY: '音色库',
  FISSION_CLONE: '爆款视频项目',
  FISSION_AVATAR: '数字人库',
  FISSION_LOCAL_REPLACE: '局部属性变更项目',
};

const TYPE_ORDER: Record<AssetWorkflowSpace, readonly AssetType[]> = {
  EFFECT: [
    'SOURCE_MATERIAL',
    'PRODUCT_ASSET',
    'VIDEO_CONFIG',
    'INSIGHT_RESULT',
    'PROMPT',
    'VIDEO_MATERIAL',
    'MIX_TEMPLATE',
    'TIMELINE_PROJECT',
    'FINAL_VIDEO',
    'DELIVERY_MANIFEST',
    'ANALYSIS_QUALITY_REPORT',
  ],
  CUSTOMIZED_PROJECT: [
    'SOURCE_MATERIAL',
    'INSIGHT_RESULT',
    'STORYBOARD_SCRIPT',
    'PROMPT',
    'PRODUCT_ASSET',
    'DIGITAL_HUMAN_CHARACTER',
    'SCENE_BACKGROUND',
    'VOICE_PROFILE',
    'VOICE_AUDIO',
    'VIDEO_MATERIAL',
    'ARCHIVE_DELIVERABLE',
    'DELIVERY_MANIFEST',
  ],
  CUSTOMIZED_VOICE_LIBRARY: ['VOICE_PROFILE'],
  FISSION_CLONE: [
    'REFERENCE_VIDEO',
    'PRODUCT_ASSET',
    'VIDEO_MATERIAL',
    'ANALYSIS_QUALITY_REPORT',
    'REPLACEMENT_MAPPING',
    'PROMPT',
    'FINAL_VIDEO',
    'DELIVERY_MANIFEST',
  ],
  FISSION_AVATAR: [
    'SCRIPT_COPY',
    'DIGITAL_HUMAN_CHARACTER',
    'AVATAR_REFERENCE',
    'VOICE_PROFILE',
    'SCENE_BACKGROUND',
    'SUBTITLE',
    'VOICE_AUDIO',
    'EDITING_PROJECT',
    'FINAL_VIDEO',
    'ANALYSIS_QUALITY_REPORT',
  ],
  FISSION_LOCAL_REPLACE: [
    'SOURCE_VIDEO',
    'REPLACEMENT_CONFIGURATION',
    'ANALYSIS_QUALITY_REPORT',
    'REFERENCE_SET',
    'REPLACEMENT_MAPPING',
    'PROMPT',
    'FINAL_VIDEO',
    'DELIVERY_MANIFEST',
  ],
};

export const typesForSpace = (
  space: AssetWorkflowSpace,
  available: readonly AssetType[] = [],
): AssetType[] => {
  const preferred = TYPE_ORDER[space];
  const pool = new Set(available.length ? available : preferred);
  return [
    ...preferred.filter((type) => pool.has(type)),
    ...available.filter((type) => !preferred.includes(type)),
  ];
};

export const statusOf = (asset: Asset): AssetStatus =>
  asset.qualityStatus ?? asset.status ?? 'AVAILABLE';

export const STATUS_CLASS: Record<AssetStatus, 'green' | 'orange' | 'red'> = {
  AVAILABLE: 'green',
  PENDING_REVIEW: 'orange',
  QUALITY_WARNING: 'orange',
  UNAVAILABLE: 'red',
};

export const STATUS_LABELS: Record<AssetStatus, string> = {
  AVAILABLE: '可用',
  PENDING_REVIEW: '待审核',
  QUALITY_WARNING: '质量预警',
  UNAVAILABLE: '不可用',
};

const TYPE_LABEL_FALLBACK: Record<AssetType, string> = {
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
  ANALYSIS_QUALITY_REPORT: '分析与质检报告',
};

export const versionOf = (asset: Asset): number => asset.currentVersion ?? asset.sourceVersion ?? 1;

export const projectMatchesSpace = (project: Project, space: AssetWorkflowSpace): boolean => {
  const counts = project.assetCounts?.[space] ?? 0;
  if (counts > 0) return true;
  const membership = project.workflowSpaces;
  if (!membership) return false;
  if (space === 'EFFECT') return membership.effect;
  if (space === 'CUSTOMIZED_PROJECT') return membership.customized;
  if (space === 'FISSION_CLONE') return membership.fission.clone;
  if (space === 'FISSION_AVATAR') return membership.fission.avatar;
  if (space === 'FISSION_LOCAL_REPLACE') return membership.fission.localReplace;
  return false;
};

export const assetSearchText = (project: Project): string =>
  [project.name, project.id, project.client, project.productName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

export const uploadAccept = (type: AssetType): string => {
  if (
    ['GENERIC_VIDEO', 'REFERENCE_VIDEO', 'SOURCE_VIDEO', 'VIDEO_MATERIAL', 'FINAL_VIDEO'].includes(
      type,
    )
  )
    return 'video/*';
  if (['VOICE_AUDIO', 'VOICE_PROFILE'].includes(type)) return 'audio/*';
  if (
    [
      'DIGITAL_HUMAN_CHARACTER',
      'AVATAR_REFERENCE',
      'PERSON_ASSET',
      'PRODUCT_ASSET',
      'SCENE_BACKGROUND',
      'VISUAL_ASSET',
    ].includes(type)
  )
    return 'image/*,video/*';
  if (type === 'SUBTITLE') return '.srt,.ass,.vtt,.txt';
  return '.txt,.md,.json,.csv,.pdf,.doc,.docx,.xlsx';
};

export const typeLabel = (type: AssetType): string =>
  ASSET_TYPE_LABELS?.[type] ?? TYPE_LABEL_FALLBACK[type] ?? String(type);
