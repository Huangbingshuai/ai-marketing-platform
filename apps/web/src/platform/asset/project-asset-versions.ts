import type { EffectWorkflowBranchTreeData } from '@ai-marketing/contracts';
import {
  buildEffectBranchLayout,
  type BranchTreeNode,
} from '../../workflows/effect/source-import/components/effect-workflow-branch-layout';
import { EFFECT_ASSET_NODES } from './project-asset-browser';

export type AssetBrowseVersion = BranchTreeNode & { label: string; path: string };
const versionName = (revision: number | null) =>
  revision === null ? '版本未记录' : `版本${String(revision).padStart(2, '0')}`;

/** Use the same source-head/ordinal resolver as the existing branch tree, never count copies. */
export function assetVersionCatalog(tree: EffectWorkflowBranchTreeData | null): {
  versions: AssetBrowseVersion[];
  templates: { id: string; name: string }[];
} {
  const layout = buildEffectBranchLayout(tree?.branches ?? []);
  const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
  const parents = new Map(
    layout.edges.flatMap((edge) => {
      const [parent, child] = edge.key.split('->');
      return parent && child && byKey.has(parent) ? [[child, parent] as const] : [];
    }),
  );
  const shortNames: Record<string, string> = {
    SOURCE_IMPORT: '资料',
    INFORMATION_EXTRACTION: '信息',
    PROMPT_GENERATION: '提示词',
    SEGMENT_RENDER: '视频',
    MIX_FILL: '填充',
    MIX_PACKAGING: '包装',
    FINAL_OUTPUT: '成片',
  };
  const pathOf = (node: BranchTreeNode) => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cursor: BranchTreeNode | undefined = node;
    while (cursor && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      parts.unshift(
        cursor.stageKey === 'MIX_TEMPLATE'
          ? (cursor.templateName ?? '混剪模板')
          : `${shortNames[cursor.stageKey] ?? cursor.stageKey}${
              cursor.revision === null ? '（未记录）' : String(cursor.revision).padStart(2, '0')
            }`,
      );
      cursor = byKey.get(parents.get(cursor.key) ?? '');
    }
    return parts.join(' / ');
  };
  const templates = new Map<string, { id: string; name: string }>();
  for (const node of layout.nodes)
    if (node.templateId)
      templates.set(node.templateId, {
        id: node.templateId,
        name: node.templateName ?? '未命名模板',
      });
  const versions = layout.nodes
    .filter(
      (node) =>
        EFFECT_ASSET_NODES.some((entry) => entry.value === node.nodeId) &&
        node.status !== 'PENDING' &&
        node.artifactCount > 0,
    )
    .map((node) => ({ ...node, label: versionName(node.revision), path: pathOf(node) }));
  return { versions, templates: [...templates.values()] };
}

export function versionsForNode(
  versions: AssetBrowseVersion[],
  nodeId: string,
  templateId: string | null,
) {
  return versions.filter(
    (version) =>
      version.nodeId === nodeId && (nodeId !== 'FINAL_OUTPUT' || version.templateId === templateId),
  );
}
export function defaultAssetVersion(versions: AssetBrowseVersion[]): AssetBrowseVersion | null {
  return (
    versions.find((version) => version.onActivePath) ??
    [...versions].sort(
      (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.key.localeCompare(a.key),
    )[0] ??
    null
  );
}
