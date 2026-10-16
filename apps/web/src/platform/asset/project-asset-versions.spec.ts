import {
  EFFECT_WORKFLOW_BRANCH_NODES,
  type EffectWorkflowBranch,
  type EffectWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import browserSource from './components/ProjectAssetBrowser.vue?raw';
import treeSource from '../../workflows/effect/source-import/components/EffectWorkflowBranchTree.vue?raw';
import {
  assetVersionCatalog,
  defaultAssetVersion,
  versionsForNode,
} from './project-asset-versions';

const branch = (
  id: string,
  parent: string | null,
  fork: EffectWorkflowBranch['forkNodeId'],
): EffectWorkflowBranch => ({
  workflowRunId: id,
  parentWorkflowRunId: parent,
  forkNodeId: fork,
  forkTemplateId: null,
  label: id,
  currentNodeId: 'SEGMENT_RENDER',
  isActive: id === 'new',
  createdAt: '2026-10-07T01:00:00Z',
  nodes: EFFECT_WORKFLOW_BRANCH_NODES.map((nodeId) => ({
    nodeId,
    status: 'CONFIRMED',
    artifactCount: 1,
    revision: id === 'new' ? 2 : 1,
    artifactCreatedAt: '2026-10-07T01:00:00Z',
  })),
  templates: ['a', 'b'].map((templateId) => ({
    templateId,
    name: `模板${templateId}`,
    templateRevision: 1,
    fillRevision: 1,
    packagingRevision: 1,
    timelineVariantCount: 1,
    packagingVariantCount: 1,
    deliveryRevision: 1,
    deliveryCount: 2,
  })),
});
const tree = (branches: EffectWorkflowBranch[]): EffectWorkflowBranchTreeData => ({
  projectId: 'project',
  activeWorkflowRunId: 'new',
  branches,
});

describe('asset library branch scopes', () => {
  it('reuses source heads and does not list downstream inherited Prompt copies as new versions', () => {
    const child = branch('mix', 'new', 'TEMPLATE_MIX');
    child.forkTemplateId = 'a';
    child.forkMixStage = 'PACKAGING';
    const result = assetVersionCatalog(
      tree([branch('root', null, null), branch('new', 'root', 'SEGMENT_RENDER'), child]),
    );
    expect(
      versionsForNode(result.versions, 'SOURCE_IMPORT', null).map((item) => item.workflowRunId),
    ).toEqual(['root']);
    expect(
      versionsForNode(result.versions, 'PROMPT_GENERATION', null).map((item) => item.workflowRunId),
    ).toEqual(['root']);
    expect(
      versionsForNode(result.versions, 'SEGMENT_RENDER', null).map((item) => item.workflowRunId),
    ).toEqual(['root', 'new']);
    expect(
      defaultAssetVersion(versionsForNode(result.versions, 'SEGMENT_RENDER', null))?.workflowRunId,
    ).toBe('new');
  });
  it('keeps final output choices template scoped and exposes their full source path', () => {
    const result = assetVersionCatalog(tree([branch('root', null, null)]));
    expect(result.templates.map((item) => item.id)).toEqual(['a', 'b']);
    const outputs = versionsForNode(result.versions, 'FINAL_OUTPUT', 'b');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.templateId).toBe('b');
    expect(outputs[0]?.path).toContain('模板b');
    expect(outputs[0]?.path).toContain('视频01');
    expect(outputs[0]?.path).toContain('包装01');
    expect(versionsForNode(result.versions, 'FINAL_OUTPUT', null)).toEqual([]);
  });
  it('excludes pending versions and preserves manual copies as independent source heads', () => {
    const root = branch('root', null, null);
    root.nodes.find((item) => item.nodeId === 'SEGMENT_RENDER')!.status = 'PENDING';
    const copy = branch('copy', 'root', 'SOURCE_IMPORT');
    copy.creationKind = 'MANUAL_COPY';
    const result = assetVersionCatalog(tree([root, copy]));
    expect(versionsForNode(result.versions, 'SOURCE_IMPORT', null)).toHaveLength(2);
    expect(
      versionsForNode(result.versions, 'SEGMENT_RENDER', null).map((item) => item.workflowRunId),
    ).toEqual(['copy']);
    expect(assetVersionCatalog(null)).toEqual({ versions: [], templates: [] });
  });
  it('uses read-only snapshot requests and the existing tree without activating or saving branches', () => {
    expect(browserSource).toContain("view: 'SNAPSHOT'");
    expect(browserSource).toContain('snapshotController?.abort()');
    expect(browserSource).toContain('stamp === snapshotGeneration');
    expect(browserSource).toContain('strictVersion:');
    expect(browserSource).not.toContain('activateEffectWorkflowBranch');
    expect(browserSource).not.toContain('putWorkflowNodeState');
    if (treeSource.includes('class="branch-copy-button"'))
      expect(treeSource).toContain('v-if="!assetBrowse"');
    else expect(treeSource).not.toContain('@click="emit(\'fork\')"');
    expect(treeSource).toContain('selectableNodeKeys?.includes(node.key)');
  });
});
