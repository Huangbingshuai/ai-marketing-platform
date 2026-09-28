import type {
  EffectWorkflowBranch,
  EffectWorkflowBranchNodeId,
  EffectWorkflowBranchNodeStatus,
  EffectWorkflowBranchTemplate,
} from '@ai-marketing/contracts';

// These are drawing layers. The actual effect workflow still has six fixed nodes.
export const BRANCH_TREE_STAGES = [
  { key: 'SOURCE_IMPORT', nodeId: 'SOURCE_IMPORT', name: '资料导入' },
  { key: 'INFORMATION_EXTRACTION', nodeId: 'INFORMATION_EXTRACTION', name: 'AI 信息提炼' },
  { key: 'PROMPT_GENERATION', nodeId: 'PROMPT_GENERATION', name: 'Prompt 生成' },
  { key: 'SEGMENT_RENDER', nodeId: 'SEGMENT_RENDER', name: '视频渲染' },
  { key: 'MIX_TEMPLATE', nodeId: 'TEMPLATE_MIX', name: '混剪模板' },
  { key: 'MIX_FILL', nodeId: 'TEMPLATE_MIX', name: '智能填充' },
  { key: 'MIX_PACKAGING', nodeId: 'TEMPLATE_MIX', name: '智能成片包装' },
  { key: 'FINAL_OUTPUT', nodeId: 'FINAL_OUTPUT', name: '成片输出' },
] as const satisfies readonly { key: string; nodeId: EffectWorkflowBranchNodeId; name: string }[];
export type BranchStageKey = (typeof BRANCH_TREE_STAGES)[number]['key'];
export const BRANCH_TREE_AXIS_WIDTH = 178;
export const BRANCH_TREE_ROOT_TOP = 64;
export const BRANCH_TREE_NODE_WIDTH = 128;
export const BRANCH_TREE_NODE_HEIGHT = 72;
export const BRANCH_TREE_LEAF_GAP = 188;
export const BRANCH_TREE_SIDE_PADDING = 160;
export const BRANCH_TREE_ROW_GAP = 116;
export const BRANCH_TREE_TOP = 184;

export type BranchTreeNode = {
  key: string;
  workflowRunId: string;
  stageKey: BranchStageKey;
  nodeId: EffectWorkflowBranchNodeId;
  stageIndex: number;
  templateId: string | null;
  templateName: string | null;
  createdAt: string | null;
  x: number;
  y: number;
  status: EffectWorkflowBranchNodeStatus;
  artifactCount: number;
  revision: number | null;
  revisions: number[] | undefined;
  onActivePath: boolean;
  isCurrentStage: boolean;
};
export type BranchTreeEdge = {
  key: string;
  path: string;
  onActivePath: boolean;
};
export type EffectBranchLayout = {
  root: { x: number; y: number };
  nodes: BranchTreeNode[];
  edges: BranchTreeEdge[];
  width: number;
  height: number;
};

const nodeKey = (runId: string, stageKey: BranchStageKey, templateId: string | null) =>
  `${runId}:${stageKey}:${templateId ?? '-'}`;
const forkStageIndex = (branch: EffectWorkflowBranch): number => {
  if (branch.forkNodeId === 'TEMPLATE_MIX') {
    if (branch.forkMixStage === 'PACKAGING') return 6;
    if (branch.forkMixStage === 'FILL') return 5;
  }
  return Math.max(
    0,
    BRANCH_TREE_STAGES.findIndex((stage) => stage.nodeId === branch.forkNodeId),
  );
};

export function buildEffectBranchLayout(branches: EffectWorkflowBranch[]): EffectBranchLayout {
  const byId = new Map(branches.map((branch) => [branch.workflowRunId, branch]));
  const children = new Map<string | null, EffectWorkflowBranch[]>();
  for (const branch of branches) {
    const parentId =
      branch.parentWorkflowRunId && byId.has(branch.parentWorkflowRunId)
        ? branch.parentWorkflowRunId
        : null;
    children.set(parentId, [...(children.get(parentId) ?? []), branch]);
  }
  const ordered: EffectWorkflowBranch[] = [];
  const visited = new Set<string>();
  const visit = (branch: EffectWorkflowBranch) => {
    if (visited.has(branch.workflowRunId)) return;
    visited.add(branch.workflowRunId);
    ordered.push(branch);
    for (const child of children.get(branch.workflowRunId) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  for (const branch of branches) visit(branch);

  const ownerAt = (
    branch: EffectWorkflowBranch,
    stageIndex: number,
    templateId: string | null,
  ): EffectWorkflowBranch => {
    let source = branch;
    const seen = new Set<string>();
    while (source.parentWorkflowRunId && !seen.has(source.workflowRunId)) {
      seen.add(source.workflowRunId);
      const beforeFork = stageIndex < forkStageIndex(source);
      const otherTemplate =
        stageIndex >= 4 && !!source.forkTemplateId && source.forkTemplateId !== templateId;
      if (!beforeFork && !otherTemplate) break;
      const parent = byId.get(source.parentWorkflowRunId);
      if (!parent) break;
      source = parent;
    }
    return source;
  };
  const active = branches.find((branch) => branch.isActive);
  const nodes: BranchTreeNode[] = [];
  const templateFor = (branch: EffectWorkflowBranch): EffectWorkflowBranchTemplate[] => {
    if (branch.forkTemplateId && forkStageIndex(branch) >= 4) {
      const scoped = branch.templates.find(
        (template) => template.templateId === branch.forkTemplateId,
      );
      return scoped ? [scoped] : [];
    }
    return branch.templates;
  };
  for (const branch of ordered) {
    const start = branch.parentWorkflowRunId ? forkStageIndex(branch) : 0;
    for (
      let stageIndex = start;
      stageIndex < Math.min(4, BRANCH_TREE_STAGES.length);
      stageIndex++
    ) {
      const stage = BRANCH_TREE_STAGES[stageIndex]!;
      const state = branch.nodes.find((node) => node.nodeId === stage.nodeId);
      if (!state?.artifactCount) continue;
      const ownerId = active ? ownerAt(active, stageIndex, null).workflowRunId : null;
      nodes.push({
        key: nodeKey(branch.workflowRunId, stage.key, null),
        workflowRunId: branch.workflowRunId,
        stageKey: stage.key,
        nodeId: stage.nodeId,
        stageIndex,
        templateId: null,
        templateName: null,
        createdAt: state?.artifactCreatedAt ?? null,
        x: 0,
        y: BRANCH_TREE_TOP + stageIndex * BRANCH_TREE_ROW_GAP,
        status: state?.status ?? 'PENDING',
        artifactCount: state?.artifactCount ?? 0,
        revision: state?.revision ?? null,
        revisions: state?.revisions,
        onActivePath: ownerId === branch.workflowRunId,
        isCurrentStage: ownerId === branch.workflowRunId && active?.currentNodeId === stage.nodeId,
      });
    }
    for (const template of templateFor(branch)) {
      const templateId = template.templateId;
      for (
        let stageIndex = Math.max(4, start);
        stageIndex < BRANCH_TREE_STAGES.length;
        stageIndex++
      ) {
        const stage = BRANCH_TREE_STAGES[stageIndex]!;
        const state = branch.nodes.find((node) => node.nodeId === stage.nodeId);
        const confirmedFillCount = template?.timelineVariantCount ?? 0;
        const draftFillReady = Boolean(template?.draftFillReady && confirmedFillCount === 0);
        const count =
          stage.key === 'MIX_TEMPLATE'
            ? Number(
                !!template &&
                  (template.templateRevision != null || !('templateRevision' in template)),
              )
            : stage.key === 'MIX_FILL'
              ? Math.max(confirmedFillCount, draftFillReady ? 1 : 0)
              : stage.key === 'MIX_PACKAGING'
                ? (template?.packagingVariantCount ?? 0)
                : (template?.deliveryCount ?? 0);
        if (stage.key !== 'MIX_TEMPLATE' && count === 0) continue;
        const revision =
          stage.key === 'MIX_TEMPLATE'
            ? (template?.templateRevision ?? null)
            : stage.key === 'MIX_FILL'
              ? (template?.fillRevision ?? null)
              : stage.key === 'MIX_PACKAGING'
                ? (template?.packagingRevision ?? null)
                : (template?.deliveryRevision ?? null);
        const revisions =
          stage.key === 'MIX_TEMPLATE'
            ? template?.templateRevisions
            : stage.key === 'MIX_FILL'
              ? template?.fillRevisions
              : stage.key === 'MIX_PACKAGING'
                ? template?.packagingRevisions
                : template?.deliveryRevisions;
        const ownerId = active ? ownerAt(active, stageIndex, templateId).workflowRunId : null;
        nodes.push({
          key: nodeKey(branch.workflowRunId, stage.key, templateId),
          workflowRunId: branch.workflowRunId,
          stageKey: stage.key,
          nodeId: stage.nodeId,
          stageIndex,
          templateId,
          templateName: template.name,
          createdAt:
            stage.key === 'MIX_TEMPLATE'
              ? (template?.templateCreatedAt ?? null)
              : stage.key === 'MIX_FILL'
                ? (template?.fillCreatedAt ?? null)
                : stage.key === 'MIX_PACKAGING'
                  ? (template?.packagingCreatedAt ?? null)
                  : stage.key === 'FINAL_OUTPUT'
                    ? (template?.deliveryCreatedAt ?? null)
                    : null,
          x: 0,
          y: BRANCH_TREE_TOP + stageIndex * BRANCH_TREE_ROW_GAP,
          status:
            (stage.key === 'MIX_TEMPLATE' && count === 0) ||
            (stage.key === 'MIX_FILL' && draftFillReady)
              ? 'PENDING'
              : (state?.status ?? 'CONFIRMED'),
          artifactCount: count,
          revision,
          revisions,
          onActivePath: ownerId === branch.workflowRunId,
          isCurrentStage:
            ownerId === branch.workflowRunId && active?.currentNodeId === stage.nodeId,
        });
      }
    }
  }

  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const parentByKey = new Map<string, string>();
  const childrenByKey = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.stageIndex === 0) continue;
    const branch = byId.get(node.workflowRunId);
    if (!branch) continue;
    for (let previousIndex = node.stageIndex - 1; previousIndex >= 0; previousIndex--) {
      const previousStage = BRANCH_TREE_STAGES[previousIndex]!;
      const previousTemplateId = previousIndex < 4 ? null : node.templateId;
      const source = ownerAt(branch, previousIndex, previousTemplateId);
      const parentKey = nodeKey(source.workflowRunId, previousStage.key, previousTemplateId);
      if (!nodeByKey.has(parentKey)) continue;
      parentByKey.set(node.key, parentKey);
      childrenByKey.set(parentKey, [...(childrenByKey.get(parentKey) ?? []), node.key]);
      break;
    }
  }
  const roots = nodes.filter((node) => !parentByKey.has(node.key));
  let nextLeaf = 0;
  const positioned = new Set<string>();
  const place = (node: BranchTreeNode): number => {
    if (positioned.has(node.key)) return node.x;
    positioned.add(node.key);
    const descendants = (childrenByKey.get(node.key) ?? [])
      .map((key) => nodeByKey.get(key))
      .filter((child): child is BranchTreeNode => !!child);
    const descendantXs = descendants.map(place);
    node.x = descendantXs.length
      ? (descendantXs[0]! + descendantXs[descendantXs.length - 1]!) / 2
      : BRANCH_TREE_SIDE_PADDING + nextLeaf++ * BRANCH_TREE_LEAF_GAP;
    return node.x;
  };
  for (const root of roots) place(root);
  for (const node of nodes) if (!positioned.has(node.key)) place(node);

  const width = BRANCH_TREE_SIDE_PADDING * 2 + Math.max(0, nextLeaf - 1) * BRANCH_TREE_LEAF_GAP;
  const sourceRoots = roots;
  const root = {
    x: width / 2,
    y: BRANCH_TREE_ROOT_TOP,
  };
  const edges: BranchTreeEdge[] = [];
  for (const node of sourceRoots) {
    const fromY = root.y + BRANCH_TREE_NODE_HEIGHT / 2;
    const toY = node.y - BRANCH_TREE_NODE_HEIGHT / 2 - 5;
    const middle = (fromY + toY) / 2;
    edges.push({
      key: `project-root->${node.key}`,
      path: `M ${root.x} ${fromY} C ${root.x} ${middle}, ${node.x} ${middle}, ${node.x} ${toY}`,
      onActivePath: node.onActivePath,
    });
  }
  for (const node of nodes) {
    const parentKey = parentByKey.get(node.key);
    const parent = parentKey ? nodeByKey.get(parentKey) : null;
    if (!parent) continue;
    const fromY = parent.y + BRANCH_TREE_NODE_HEIGHT / 2;
    const toY = node.y - BRANCH_TREE_NODE_HEIGHT / 2 - 5;
    const middle = (fromY + toY) / 2;
    edges.push({
      key: `${parent.key}->${node.key}`,
      path: `M ${parent.x} ${fromY} C ${parent.x} ${middle}, ${node.x} ${middle}, ${node.x} ${toY}`,
      onActivePath: parent.onActivePath && node.onActivePath,
    });
  }
  return {
    root,
    nodes,
    edges,
    width,
    height: BRANCH_TREE_TOP + (BRANCH_TREE_STAGES.length - 1) * BRANCH_TREE_ROW_GAP + 88,
  };
}
