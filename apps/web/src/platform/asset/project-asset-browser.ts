import type {
  Asset,
  AssetPreviewKind,
  AssetType,
  AssetWorkflow,
  AssetWorkflowSpace,
  WorkingArtifact,
  WorkingArtifactFile,
} from '@ai-marketing/contracts';
import {
  EFFECT_WORKFLOW_BRANCH_NODES,
  type EffectWorkflowBranchNodeId,
} from '@ai-marketing/contracts';
import { workflowNodeBaseId } from '../workflow/workflow-node-id';

const EFFECT_NODE_LABELS: Record<Exclude<EffectWorkflowBranchNodeId, 'TEMPLATE_MIX'>, string> = {
  SOURCE_IMPORT: '产品资料',
  INFORMATION_EXTRACTION: '产品信息',
  PROMPT_GENERATION: '素材提示词',
  SEGMENT_RENDER: '视频素材',
  FINAL_OUTPUT: '最终成片',
};
export const EFFECT_ASSET_NODES = EFFECT_WORKFLOW_BRANCH_NODES.filter(
  (value) => value !== 'TEMPLATE_MIX',
).map((value) => ({
  value,
  label: EFFECT_NODE_LABELS[value],
}));
export const UNKNOWN_ASSET_NODE = 'UNATTRIBUTED';
export function browserAssetNodeId(item: BrowserAsset): string {
  const id = workflowNodeBaseId(item.nodeId);
  return EFFECT_ASSET_NODES.some((node) => node.value === id) ? id! : UNKNOWN_ASSET_NODE;
}
export function filterBrowserAssetsByNode(
  items: readonly BrowserAsset[],
  nodeId: string,
): BrowserAsset[] {
  return items.filter(
    (item) =>
      browserAssetNodeId(item) === nodeId &&
      (nodeId !== 'SOURCE_IMPORT' || item.category === 'IMAGE' || item.category === 'DOCUMENT'),
  );
}

const isMixProject = (type: AssetType, nodeId: string | null, key = ''): boolean =>
  workflowNodeBaseId(nodeId) === 'TEMPLATE_MIX' ||
  type === 'MIX_TEMPLATE' ||
  key.startsWith('mix-template:') ||
  type === 'TIMELINE_PROJECT' ||
  key.startsWith('timeline-project:') ||
  key.startsWith('timeline-package:');

export type AssetCategory = 'ALL' | 'VIDEO' | 'IMAGE' | 'AUDIO' | 'DOCUMENT' | 'PROJECT';
export const ASSET_CATEGORIES: { value: AssetCategory; label: string }[] = [
  { value: 'ALL', label: '全部' },
  { value: 'VIDEO', label: '视频' },
  { value: 'IMAGE', label: '图片' },
  { value: 'AUDIO', label: '音频' },
  { value: 'DOCUMENT', label: '文档与提示词' },
  { value: 'PROJECT', label: '工程与配置' },
];
export const SOURCE_ASSET_CATEGORIES: { value: AssetCategory; label: string }[] = [
  { value: 'ALL', label: '全部资料' },
  { value: 'IMAGE', label: '图片' },
  { value: 'DOCUMENT', label: '文档' },
];

/** Read-only presentation union. A working copy is never adapted into a ProjectAsset. */
export type BrowserAsset = {
  id: string;
  source:
    | { kind: 'working'; artifact: WorkingArtifact; file: WorkingArtifactFile | null }
    | { kind: 'project'; asset: Asset };
  name: string;
  type: AssetType;
  category: Exclude<AssetCategory, 'ALL'>;
  previewKind: AssetPreviewKind;
  previewUrl: string | null;
  contentUrl: string | null;
  downloadUrl: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  updatedAt: string;
  tags: string[];
  status: string;
  unavailable: boolean;
  nodeId: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const duration = (...values: unknown[]): number | null => {
  const found = values.find(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  return typeof found === 'number' ? found : null;
};
const category = (type: AssetType, kind: AssetPreviewKind): BrowserAsset['category'] => {
  if (kind === 'VIDEO' || type === 'VIDEO_MATERIAL' || type === 'FINAL_VIDEO') return 'VIDEO';
  if (
    [
      'TIMELINE_PROJECT',
      'EDITING_PROJECT',
      'MIX_TEMPLATE',
      'VIDEO_CONFIG',
      'REPLACEMENT_CONFIGURATION',
    ].includes(type)
  )
    return 'PROJECT';
  if (kind === 'IMAGE') return 'IMAGE';
  if (kind === 'AUDIO') return 'AUDIO';
  return 'DOCUMENT';
};
const workingItem = (artifact: WorkingArtifact, file: WorkingArtifactFile | null): BrowserAsset => {
  const kind = file?.previewKind ?? artifact.previewKind;
  const unavailable = artifact.availability !== 'AVAILABLE';
  return {
    id: `working:${artifact.id}${file ? `:${file.id}` : ''}`,
    source: { kind: 'working', artifact, file },
    name: artifact.type === 'SOURCE_MATERIAL' && file ? file.originalFileName : artifact.name,
    type: artifact.type,
    category: category(artifact.type, kind),
    previewKind: kind,
    previewUrl:
      kind === 'IMAGE'
        ? (file?.contentUrl ?? artifact.contentUrl)
        : kind === 'VIDEO' && artifact.type !== 'SOURCE_MATERIAL'
          ? artifact.mainPreviewUrl
          : null,
    contentUrl: file?.contentUrl ?? artifact.contentUrl,
    downloadUrl: file?.downloadUrl ?? artifact.downloadUrl,
    sizeBytes: file?.sizeBytes ?? artifact.sizeBytes,
    durationSeconds: duration(
      record(artifact.metadata).durationSeconds,
      record(artifact.metadata).duration,
      record(artifact.payload).durationSeconds,
    ),
    updatedAt: artifact.updatedAt,
    tags: artifact.tags,
    nodeId: artifact.nodeId,
    status:
      artifact.availability === 'PENDING_DELETE'
        ? '待删除'
        : artifact.availability === 'SOURCE_REMOVED'
          ? '来源已删除'
          : artifact.freshness === 'STALE'
            ? '待更新'
            : '可用',
    unavailable,
  };
};

export function buildBrowserAssets(
  working: readonly WorkingArtifact[],
  assets: readonly Asset[],
  scope: {
    projectId: string;
    workflow: AssetWorkflow;
    space: AssetWorkflowSpace;
    workflowRunId: string | null;
    strictVersion?: boolean;
    templateId?: string | null;
    /** Existing API projection of the adopted clip heads within this exact rendering version. */
    renderSourceHeads?: boolean;
  },
): BrowserAsset[] {
  const scoped = working.filter(
    (item) =>
      item.projectId === scope.projectId &&
      (scope.renderSourceHeads
        ? workflowNodeBaseId(item.nodeId) === 'SEGMENT_RENDER' &&
          record(item.metadata).branchSourceOwner === true
        : item.workflowRunId === scope.workflowRunId),
  );
  const items: BrowserAsset[] = [];
  const templateMatches = (item: WorkingArtifact): boolean =>
    !scope.templateId ||
    item.artifactKey.startsWith(`final-video:${scope.templateId}:`) ||
    item.artifactKey === `final-delivery:${scope.templateId}` ||
    record(item.metadata).templateId === scope.templateId ||
    record(item.payload).templateId === scope.templateId;
  const scopedById = new Map(scoped.map((item) => [item.id, item]));
  const visibleAssets = assets.filter((asset) => {
    if (
      asset.projectId !== scope.projectId ||
      asset.storageWorkflow !== scope.workflow ||
      asset.workflowSpace !== scope.space
    )
      return false;
    const linked = asset.sourceArtifactId ? scopedById.get(asset.sourceArtifactId) : undefined;
    if (scope.renderSourceHeads && !linked) return false;
    if (
      scope.strictVersion &&
      !linked &&
      (!scope.workflowRunId || asset.sourceRunId !== scope.workflowRunId)
    )
      return false;
    if (
      scope.templateId &&
      !(linked
        ? templateMatches(linked)
        : record(asset.businessData).templateId === scope.templateId ||
          record(asset.content).templateId === scope.templateId)
    )
      return false;
    return true;
  });
  const represented = new Set(
    visibleAssets
      .filter((item) => item.hasFile !== false)
      .flatMap((item) => (item.sourceArtifactId ? [item.sourceArtifactId] : [])),
  );
  const seen = new Set<string>();
  for (const artifact of scoped) {
    if (!templateMatches(artifact) || represented.has(artifact.id)) continue;
    if (
      scope.workflow === 'EFFECT' &&
      isMixProject(artifact.type, artifact.nodeId, artifact.artifactKey)
    )
      continue;
    // The batch is an index, not an additional copy of every video in the pool.
    if (artifact.artifactKey.startsWith('render-batch:')) continue;
    if (scope.workflow === 'EFFECT' && artifact.artifactKey.startsWith('final-delivery:')) continue;
    let files: Array<WorkingArtifactFile | null>;
    if (artifact.type === 'SOURCE_MATERIAL' && artifact.files.length) files = artifact.files;
    else {
      const mediaKind =
        artifact.type === 'VIDEO_MATERIAL' || artifact.type === 'FINAL_VIDEO'
          ? 'VIDEO'
          : artifact.previewKind;
      const main = artifact.files.find((file) => file.previewKind === mediaKind);
      files = [main ?? null];
    }
    for (const file of files) {
      // A role/cover referenced by several records is not another file; preserve
      // differing availability/freshness so an invalid reference never masks a valid one.
      const identity = file
        ? `${file.fileObjectId}:${artifact.type}:${workflowNodeBaseId(artifact.nodeId)}:${artifact.availability}:${artifact.freshness}`
        : artifact.id;
      if (seen.has(identity)) continue;
      seen.add(identity);
      items.push(workingItem(artifact, file));
    }
  }
  for (const asset of visibleAssets) {
    const linked = asset.sourceArtifactId ? scopedById.get(asset.sourceArtifactId) : undefined;
    if (
      asset.projectId !== scope.projectId ||
      asset.storageWorkflow !== scope.workflow ||
      asset.workflowSpace !== scope.space
    )
      continue;
    if (scope.workflow === 'EFFECT' && isMixProject(asset.type, asset.sourceNode ?? null)) continue;
    items.push({
      id: `project:${asset.id}`,
      source: { kind: 'project', asset },
      name: asset.name,
      type: asset.type,
      category: category(asset.type, asset.hasFile === false ? 'DOWNLOAD' : asset.previewKind),
      previewKind: asset.hasFile === false ? 'DOWNLOAD' : asset.previewKind,
      previewUrl:
        asset.previewKind === 'IMAGE' && asset.hasFile !== false ? asset.contentUrl : null,
      contentUrl: asset.hasFile !== false ? asset.contentUrl || null : null,
      downloadUrl: asset.hasFile !== false ? asset.downloadUrl || null : null,
      sizeBytes: asset.sizeBytes,
      durationSeconds: duration(
        record(asset.businessData).durationSeconds,
        record(asset.content).durationSeconds,
        record(linked?.metadata).durationSeconds,
        record(linked?.metadata).duration,
        record(linked?.payload).durationSeconds,
      ),
      updatedAt: asset.updatedAt,
      tags: asset.tags,
      nodeId: asset.sourceNode ?? null,
      status: asset.outdated
        ? '来源有更新'
        : asset.qualityStatus === 'UNAVAILABLE' || asset.status === 'UNAVAILABLE'
          ? '不可用'
          : '可用',
      unavailable: asset.qualityStatus === 'UNAVAILABLE' || asset.status === 'UNAVAILABLE',
    });
  }
  return items;
}

export function filterBrowserAssets(
  items: readonly BrowserAsset[],
  categoryFilter: AssetCategory,
  keyword: string,
  sort: 'media' | 'recent' | 'name',
): BrowserAsset[] {
  const needle = keyword.trim().toLocaleLowerCase();
  const order: Record<BrowserAsset['category'], number> = {
    VIDEO: 0,
    IMAGE: 1,
    AUDIO: 2,
    DOCUMENT: 3,
    PROJECT: 4,
  };
  return items
    .filter(
      (item) =>
        (categoryFilter === 'ALL' || item.category === categoryFilter) &&
        (!needle || [item.name, ...item.tags].join(' ').toLocaleLowerCase().includes(needle)),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : (sort === 'media' ? order[a.category] - order[b.category] : 0) ||
          b.updatedAt.localeCompare(a.updatedAt),
    );
}

export const formatAssetSize = (size: number | null): string => {
  if (size === null || !Number.isFinite(size) || size <= 0) return '—';
  return size >= 1024 ** 2
    ? `${(size / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
};
export const formatAssetTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
};
export const assetSourceLabel = (item: BrowserAsset): string =>
  item.source.kind === 'working' ? '工作副本' : '项目资产';

export function assetFileFormat(item: BrowserAsset): string {
  const name =
    item.source.kind === 'working'
      ? (item.source.file?.originalFileName ?? item.source.artifact.originalFileName)
      : item.source.asset.originalFileName;
  return name?.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toUpperCase() ?? '文件';
}

export function groupSourceAssets(items: readonly BrowserAsset[]) {
  return SOURCE_ASSET_CATEGORIES.filter((option) => option.value !== 'ALL').flatMap((option) => {
    const members = items.filter((item) => item.category === option.value);
    return members.length ? [{ ...option, items: members }] : [];
  });
}

export function assetSummary(item: BrowserAsset): string {
  if (item.source.kind === 'project')
    return item.source.asset.notes || item.source.asset.originalFileName || '';
  const artifact = item.source.artifact;
  if (item.source.file) return item.source.file.originalFileName;
  if (item.category === 'PROJECT') return '已保存的工程或配置，可返回对应节点查看。';
  if (item.type === 'INSIGHT_RESULT') return '已确认的产品信息与卖点。';
  if (item.type === 'PROMPT') return '已确认的视频素材提示词。';
  return artifact.originalFileName || '已保存的工作流产物。';
}

export function assetTextFields(item: BrowserAsset): { label: string; value: string }[] {
  const payload = record(
    item.source.kind === 'working' ? item.source.artifact.payload : item.source.asset.content,
  );
  const labels: Record<string, string> = {
    productName: '产品',
    productCategory: '品类',
    coreSpecification: '规格',
    styleTone: '风格',
    aspectRatio: '画幅',
    resolution: '分辨率',
    description: '说明',
  };
  return Object.entries(labels).flatMap(([key, label]) => {
    const value = payload[key];
    return typeof value === 'string' || typeof value === 'number'
      ? [{ label, value: String(value) }]
      : [];
  });
}
