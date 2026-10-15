import type {
  EffectWorkflowBranch,
  EffectWorkflowBranchNodeId,
  EffectWorkflowBranchNodeStatus,
  EffectWorkflowBranchTemplate,
} from '@ai-marketing/contracts';
import { effectTemplateBranchTips } from '@ai-marketing/contracts';
import { EFFECT_NODE_LABELS } from '../../shared/effect-node-labels';

// These are drawing layers. The actual effect workflow still has six fixed nodes.
export const BRANCH_TREE_STAGES = [
  { key: 'SOURCE_IMPORT', nodeId: 'SOURCE_IMPORT', name: EFFECT_NODE_LABELS.SOURCE_IMPORT },
  {
    key: 'INFORMATION_EXTRACTION',
    nodeId: 'INFORMATION_EXTRACTION',
    name: EFFECT_NODE_LABELS.INFORMATION_EXTRACTION,
  },
  {
    key: 'PROMPT_GENERATION',
    nodeId: 'PROMPT_GENERATION',
    name: EFFECT_NODE_LABELS.PROMPT_GENERATION,
  },
  { key: 'SEGMENT_RENDER', nodeId: 'SEGMENT_RENDER', name: EFFECT_NODE_LABELS.SEGMENT_RENDER },
  { key: 'MIX_TEMPLATE', nodeId: 'TEMPLATE_MIX', name: '混剪模板' },
  { key: 'MIX_FILL', nodeId: 'TEMPLATE_MIX', name: '智能填充' },
  { key: 'MIX_PACKAGING', nodeId: 'TEMPLATE_MIX', name: '智能成片包装' },
  { key: 'FINAL_OUTPUT', nodeId: 'FINAL_OUTPUT', name: EFFECT_NODE_LABELS.FINAL_OUTPUT },
] as const satisfies readonly { key: string; nodeId: EffectWorkflowBranchNodeId; name: string }[];
export type BranchStageKey = (typeof BRANCH_TREE_STAGES)[number]['key'];
export const BRANCH_TREE_AXIS_WIDTH = 178;
export const BRANCH_TREE_ROOT_TOP = 60;
export const BRANCH_TREE_NODE_WIDTH = 184;
export const BRANCH_TREE_NODE_HEIGHT = 88;
export const BRANCH_TREE_LEAF_GAP = 232;
export const BRANCH_TREE_SIDE_PADDING = 144;
export const BRANCH_TREE_ROW_GAP = 124;
export const BRANCH_TREE_TOP = 184;

export type BranchTreeNode = {
  displayLabel?: string | undefined;
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
  showStaleWarning: boolean;
  artifactCount: number;
  revision: number | null;
  revisions: number[] | undefined;
  onActivePath: boolean;
  isCurrentStage: boolean;
};
export type BranchTreeEdge = {
  key: string;
  path: string;
  arrowPath: string;
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
  if (branch.forkNodeId === 'FINAL_OUTPUT' && branch.packagingInOutputBranch) return 6;
  if (branch.forkNodeId === 'TEMPLATE_MIX') {
    if (branch.forkMixStage === 'PACKAGING') return 6;
    if (branch.forkMixStage === 'FILL') return 5;
  }
  return Math.max(
    0,
    BRANCH_TREE_STAGES.findIndex((stage) => stage.nodeId === branch.forkNodeId),
  );
};

const edgeGeometry = (fromX: number, fromY: number, toX: number, nodeY: number) => {
  const tipY = nodeY - BRANCH_TREE_NODE_HEIGHT / 2 - 3;
  const stemEndY = tipY - 7;
  const deltaX = toX - fromX;
  const radius = Math.min(9, Math.abs(deltaX) / 2, (stemEndY - fromY) / 4);
  const bendY = fromY + Math.min(18, (stemEndY - fromY) / 2);
  const direction = Math.sign(deltaX);
  const path =
    direction === 0
      ? `M ${fromX} ${fromY} L ${toX} ${stemEndY}`
      : `M ${fromX} ${fromY} L ${fromX} ${bendY - radius}` +
        ` Q ${fromX} ${bendY} ${fromX + direction * radius} ${bendY}` +
        ` L ${toX - direction * radius} ${bendY}` +
        ` Q ${toX} ${bendY} ${toX} ${bendY + radius}` +
        ` L ${toX} ${stemEndY}`;
  return {
    path,
    arrowPath: `M ${toX - 5} ${stemEndY - 1} L ${toX + 5} ${stemEndY - 1}` + ` L ${toX} ${tipY} Z`,
  };
};

export function buildEffectBranchLayout(
  branches: EffectWorkflowBranch[],
  activeTemplateId: string | null = null,
  viewedWorkflowRunId: string | null = null,
): EffectBranchLayout {
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

  const inheritedOwnerAt = (
    branch: EffectWorkflowBranch,
    stageIndex: number,
    templateId: string | null,
  ): EffectWorkflowBranch => {
    let source = branch;
    const seen = new Set<string>();
    while (source.parentWorkflowRunId && !seen.has(source.workflowRunId)) {
      seen.add(source.workflowRunId);
      const parent = byId.get(source.parentWorkflowRunId);
      if (!parent) break;
      // A template created after a fill/packaging fork belongs to that child, even though the
      // fork itself started below the template layer. There is no parent template to inherit.
      if (
        stageIndex >= 4 &&
        templateId &&
        !parent.templates.some((template) => template.templateId === templateId)
      )
        break;
      // Confirming a template that already existed as a draft in the parent must not draw a
      // second template node. The child owns the new fill, not a new template identity.
      if (
        stageIndex === 4 &&
        templateId &&
        source.forkNodeId === 'TEMPLATE_MIX' &&
        source.creationKind !== 'MANUAL_COPY' &&
        parent.templates.some((template) => template.templateId === templateId)
      ) {
        source = parent;
        continue;
      }
      const beforeFork = stageIndex < forkStageIndex(source);
      const otherTemplate =
        stageIndex >= 4 && !!source.forkTemplateId && source.forkTemplateId !== templateId;
      if (!beforeFork && !otherTemplate) break;
      source = parent;
    }
    return source;
  };
  // A template can also appear in a sibling's saved workspace. It is still the same
  // template identity under the same rendering path, rather than a new tree branch.
  // Separate upstream versions and manual copies have distinct rendering owners.
  const templateScopeKey = (branch: EffectWorkflowBranch, templateId: string) =>
    nodeKey(inheritedOwnerAt(branch, 3, null).workflowRunId, 'MIX_TEMPLATE', templateId);
  const templateOwners = new Map<string, EffectWorkflowBranch>();
  for (const branch of [...ordered].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.workflowRunId.localeCompare(right.workflowRunId),
  )) {
    for (const template of branch.templates) {
      const key = templateScopeKey(branch, template.templateId);
      if (!templateOwners.has(key)) {
        templateOwners.set(key, inheritedOwnerAt(branch, 4, template.templateId));
      }
    }
  }
  const ownerAt = (
    branch: EffectWorkflowBranch,
    stageIndex: number,
    templateId: string | null,
  ): EffectWorkflowBranch =>
    stageIndex === 4 && templateId
      ? (templateOwners.get(templateScopeKey(branch, templateId)) ??
        inheritedOwnerAt(branch, stageIndex, templateId))
      : inheritedOwnerAt(branch, stageIndex, templateId);
  // Template browsing does not activate the project-wide Run. Highlight the actual editor
  // scope when supplied, rather than coloring another template/history's active Run red.
  const active =
    (activeTemplateId && viewedWorkflowRunId
      ? branches.find(
          (branch) =>
            branch.workflowRunId === viewedWorkflowRunId &&
            branch.templates.some((template) => template.templateId === activeTemplateId),
        )
      : undefined) ?? branches.find((branch) => branch.isActive);
  // Configuration shows each template's user-selected path; refinement stays on its exact branch.
  const pathContext = active && activeTemplateId === null ? ownerAt(active, 3, null) : active;
  const latestByTemplate = effectTemplateBranchTips(branches, pathContext?.workflowRunId ?? null, {
    current: activeTemplateId === null,
  });
  if (activeTemplateId === null && active) {
    // A child is newer than its ancestor even when historical timestamps are identical.
    for (const [templateId, candidate] of latestByTemplate) {
      if (
        candidate.templates.find((template) => template.templateId === templateId)
          ?.currentConfirmedAt ||
        candidate.templates.find((template) => template.templateId === templateId)
          ?.currentSelectedAt
      )
        continue;
      if (!active.templates.some((template) => template.templateId === templateId)) continue;
      let cursor: EffectWorkflowBranch | undefined = active;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.workflowRunId)) {
        if (cursor.workflowRunId === candidate.workflowRunId) {
          latestByTemplate.set(templateId, active);
          break;
        }
        seen.add(cursor.workflowRunId);
        cursor = cursor.parentWorkflowRunId ? byId.get(cursor.parentWorkflowRunId) : undefined;
      }
    }
  }
  const highlightedTips =
    activeTemplateId === null
      ? [...latestByTemplate.values()]
      : active?.templates.some((template) => template.templateId === activeTemplateId)
        ? [active]
        : latestByTemplate.has(activeTemplateId)
          ? [latestByTemplate.get(activeTemplateId)!]
          : [];
  const upstreamPathOwners = (stageIndex: number): Set<string> =>
    new Set(
      (highlightedTips.length ? highlightedTips : active ? [active] : []).map(
        (branch) => ownerAt(branch, stageIndex, null).workflowRunId,
      ),
    );
  const nodes: BranchTreeNode[] = [];
  const templateFor = (branch: EffectWorkflowBranch): EffectWorkflowBranchTemplate[] => {
    if (branch.forkTemplateId && forkStageIndex(branch) >= 4) {
      const inheritedIds = new Set(
        (branch.parentWorkflowRunId ? byId.get(branch.parentWorkflowRunId)?.templates : [])?.map(
          (template) => template.templateId,
        ) ?? [],
      );
      return branch.templates.filter(
        (template) =>
          template.templateId === branch.forkTemplateId || !inheritedIds.has(template.templateId),
      );
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
      const onActivePath = upstreamPathOwners(stageIndex).has(branch.workflowRunId);
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
        showStaleWarning: state?.status === 'STALE',
        artifactCount: state?.artifactCount ?? 0,
        revision: state?.revision ?? null,
        revisions: state?.revisions,
        onActivePath,
        isCurrentStage:
          onActivePath &&
          active?.currentNodeId === stage.nodeId &&
          ownerAt(active, stageIndex, null).workflowRunId === branch.workflowRunId,
      });
    }
    for (const template of templateFor(branch)) {
      const templateId = template.templateId;
      const existsInParent =
        start >= 4 &&
        branch.creationKind !== 'MANUAL_COPY' &&
        branch.parentWorkflowRunId &&
        byId
          .get(branch.parentWorkflowRunId)
          ?.templates.some((parentTemplate) => parentTemplate.templateId === templateId);
      for (
        let stageIndex = existsInParent ? Math.max(5, start) : 4;
        stageIndex < BRANCH_TREE_STAGES.length;
        stageIndex++
      ) {
        const stage = BRANCH_TREE_STAGES[stageIndex]!;
        if (
          stage.key === 'MIX_TEMPLATE' &&
          ownerAt(branch, stageIndex, templateId).workflowRunId !== branch.workflowRunId
        )
          continue;
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
        const tip =
          activeTemplateId === templateId &&
          active?.templates.some((template) => template.templateId === templateId)
            ? active
            : latestByTemplate.get(templateId);
        const onActivePath = Boolean(
          (activeTemplateId === null || activeTemplateId === templateId) &&
          tip &&
          ownerAt(tip, stageIndex, templateId).workflowRunId === branch.workflowRunId,
        );
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
              : stage.key === 'MIX_PACKAGING' && template.fillStatus === 'STALE'
                ? 'STALE'
                : ((stage.key === 'MIX_TEMPLATE'
                    ? template.templateStatus
                    : stage.key === 'MIX_FILL'
                      ? template.fillStatus
                      : stage.key === 'MIX_PACKAGING'
                        ? template.packagingStatus
                        : template.deliveryStatus) ??
                  state?.status ??
                  'CONFIRMED'),
          showStaleWarning: false,
          artifactCount: count,
          revision,
          revisions,
          onActivePath,
          isCurrentStage:
            onActivePath &&
            activeTemplateId === templateId &&
            active?.currentNodeId === stage.nodeId &&
            ownerAt(active, stageIndex, templateId).workflowRunId === branch.workflowRunId,
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
  // Warn on the packaged project's own visual/audio state, rather than duplicating
  // that warning on its shared fill head. A sibling's refreshed fill must not clear
  // an older packaged project's warning, or make a refreshed project stale again.
  const packagedFillHeads = new Set<string>();
  for (const node of nodes) {
    if (node.stageKey !== 'MIX_PACKAGING') continue;
    let parentKey = parentByKey.get(node.key);
    while (parentKey) {
      const parent = nodeByKey.get(parentKey);
      if (!parent || parent.stageIndex < 5) break;
      if (parent.stageKey === 'MIX_FILL') {
        packagedFillHeads.add(parent.key);
        break;
      }
      parentKey = parentByKey.get(parentKey);
    }
  }
  for (const node of nodes) {
    node.showStaleWarning =
      node.status === 'STALE' &&
      node.stageKey !== 'MIX_TEMPLATE' &&
      !packagedFillHeads.has(node.key);
  }
  // Configuration highlights every template's latest path; the editor highlights its template.
  // Older sibling versions stay visible without inheriting either path's red highlight.
  const nodeCreatedTime = (node: BranchTreeNode): number => {
    const createdAt = Date.parse(node.createdAt ?? '');
    if (Number.isFinite(createdAt)) return createdAt;
    const runCreatedAt = Date.parse(byId.get(node.workflowRunId)?.createdAt ?? '');
    return Number.isFinite(runCreatedAt) ? runCreatedAt : 0;
  };
  // A new template can live in an old Run. Order the actual drawing siblings by their
  // own creation time, not by the DFS order of the Runs that happen to contain them.
  const chronologicalNodes = (left: BranchTreeNode, right: BranchTreeNode) =>
    nodeCreatedTime(left) - nodeCreatedTime(right) || left.key.localeCompare(right.key);
  return placeWorkflowBranchNodes(
    nodes,
    parentByKey,
    BRANCH_TREE_STAGES.length,
    chronologicalNodes,
  );
}

/** Shared branch geometry and lane placement; callers supply workflow-specific ownership. */
export function placeWorkflowBranchNodes<
  T extends Pick<BranchTreeNode, 'key' | 'x' | 'y' | 'onActivePath'>,
>(
  nodes: T[],
  parentByKey: Map<string, string>,
  stageCount: number,
  compare: (left: T, right: T) => number,
) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const childrenByKey = new Map<string, string[]>();
  for (const [key, parent] of parentByKey)
    childrenByKey.set(parent, [...(childrenByKey.get(parent) ?? []), key]);
  const roots = nodes.filter((node) => !parentByKey.has(node.key));
  roots.sort(compare);
  let nextLeaf = 0;
  const positioned = new Map<string, { left: number; right: number }>();
  const place = (node: T): { left: number; right: number } => {
    const existing = positioned.get(node.key);
    if (existing) return existing;
    const descendants = (childrenByKey.get(node.key) ?? [])
      .map((key) => nodeByKey.get(key))
      .filter((child): child is T => !!child)
      .sort(compare);
    const descendantSpans = descendants.map(place);
    // Give each subtree its own leaf lanes, then center its parent over the
    // entire occupied span. A single continuation stays vertical; forks grow
    // on both sides without changing chronology, ownership or node identity.
    const leafX = descendantSpans.length
      ? 0
      : BRANCH_TREE_SIDE_PADDING + nextLeaf++ * BRANCH_TREE_LEAF_GAP;
    const span = descendantSpans.length
      ? { left: descendantSpans[0]!.left, right: descendantSpans.at(-1)!.right }
      : { left: leafX, right: leafX };
    node.x = (span.left + span.right) / 2;
    positioned.set(node.key, span);
    return span;
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
    edges.push({
      key: `project-root->${node.key}`,
      ...edgeGeometry(root.x, fromY, node.x, node.y),
      onActivePath: node.onActivePath,
    });
  }
  for (const node of nodes) {
    const parentKey = parentByKey.get(node.key);
    const parent = parentKey ? nodeByKey.get(parentKey) : null;
    if (!parent) continue;
    const fromY = parent.y + BRANCH_TREE_NODE_HEIGHT / 2;
    edges.push({
      key: `${parent.key}->${node.key}`,
      ...edgeGeometry(parent.x, fromY, node.x, node.y),
      onActivePath: parent.onActivePath && node.onActivePath,
    });
  }
  return {
    root,
    nodes,
    edges,
    width,
    height: BRANCH_TREE_TOP + (stageCount - 1) * BRANCH_TREE_ROW_GAP + 88,
  };
}

export type WorkflowBranchDisplayNode = Omit<BranchTreeNode, 'nodeId' | 'stageKey'> & {
  nodeId: string;
  stageKey: string;
};
export type WorkflowBranchDisplayLayout = Omit<EffectBranchLayout, 'nodes'> & {
  nodes: WorkflowBranchDisplayNode[];
};
