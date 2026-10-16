import { EFFECT_WORKFLOW_BRANCH_NODES, type EffectWorkflowBranch } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import { buildEffectBranchLayout } from '../source-import/components/effect-workflow-branch-layout';
import {
  consumeEffectNavigation,
  effectBranchDestination,
  effectBranchNavigationMatches,
  effectMixHistoryTemplateId,
  effectTemplateStepNavigation,
} from './effect-branch-navigation';

const makeBranch = (id: string): EffectWorkflowBranch => ({
  workflowRunId: id,
  parentWorkflowRunId: null,
  forkNodeId: null,
  forkTemplateId: null,
  label: id,
  createdAt: '2026-10-03T00:00:00Z',
  currentNodeId: 'FINAL_OUTPUT',
  isActive: true,
  nodes: EFFECT_WORKFLOW_BRANCH_NODES.map((nodeId) => ({
    nodeId,
    status: 'CONFIRMED',
    artifactCount: 1,
    revision: 1,
  })),
  templates: [
    {
      templateId: 'template-a',
      name: '测试 A',
      templateRevision: 1,
      templateCreatedAt: '2026-10-03T00:00:00Z',
      fillRevision: 2,
      fillCreatedAt: '2026-10-03T00:01:00Z',
      timelineVariantCount: 4,
      packagingRevision: 3,
      packagingCreatedAt: '2026-10-03T00:02:00Z',
      packagingVariantCount: 4,
      deliveryRevision: 4,
      deliveryCount: 1,
    },
  ],
});

describe('effect branch navigation', () => {
  it('consumes a completed command at the parent so remounting cannot replay history', () => {
    const historical = { workflowRunId: 'old', templateId: 'a' };
    expect(consumeEffectNavigation(historical, historical)).toBeNull();
    expect(consumeEffectNavigation(null, historical)).toBeNull();
    const newer = { workflowRunId: 'current', templateId: 'a' };
    expect(consumeEffectNavigation(newer, historical)).toBe(newer);
    expect(consumeEffectNavigation({ ...historical }, historical)).not.toBeNull();
  });
  it.each(['TEMPLATE', null] as const)(
    'does not pin the current list for a %s destination',
    (mixStage) => {
      const target = {
        projectId: 'project',
        workflowRunId: 'old',
        nodeId: 'TEMPLATE_MIX' as const,
        templateId: 'a',
        mixStage,
      };
      for (const view of ['CONFIG', 'EDITOR'] as const)
        expect(effectMixHistoryTemplateId(target, 'project', 'old', view, true)).toBeNull();
    },
  );
  it.each(['FILL', 'PACKAGING'] as const)(
    'releases the %s history when returning to config',
    (mixStage) => {
      const target = {
        projectId: 'project',
        workflowRunId: 'old',
        nodeId: 'TEMPLATE_MIX' as const,
        templateId: 'a',
        mixStage,
      };
      expect(effectMixHistoryTemplateId(target, 'project', 'old', 'CONFIG', true)).toBe('a');
      expect(effectMixHistoryTemplateId(target, 'project', 'old', 'EDITOR', false)).toBe('a');
      expect(effectMixHistoryTemplateId(target, 'project', 'old', 'CONFIG', false)).toBeNull();
      expect(effectMixHistoryTemplateId(target, 'other', 'old', 'EDITOR', true)).toBeNull();
      expect(effectMixHistoryTemplateId(target, 'project', 'other', 'EDITOR', true)).toBeNull();
      expect(
        effectMixHistoryTemplateId(
          { ...target, nodeId: 'FINAL_OUTPUT' },
          'project',
          'old',
          'EDITOR',
          true,
        ),
      ).toBeNull();
    },
  );
  it.each(['current', 'historical'])(
    'carries the selected template to output on the exact %s branch',
    (workflowRunId) => {
      expect(effectTemplateStepNavigation('project', workflowRunId, 4, 5, 'template-8')).toEqual({
        projectId: 'project',
        workflowRunId,
        templateId: 'template-8',
        nodeId: 'FINAL_OUTPUT',
        mixStage: null,
      });
    },
  );

  it('does not reuse a cached mix template for other page transitions', () => {
    expect(effectTemplateStepNavigation('project', 'run', 3, 5, 'old-template')).toBeNull();
    expect(effectTemplateStepNavigation('project', 'run', 4, 3, 'old-template')).toBeNull();
    expect(effectTemplateStepNavigation('project', 'run', 4, 5, null)).toBeNull();
  });

  it('routes every visible stage to its workflow page and preserves template and stage identity', () => {
    const nodes = buildEffectBranchLayout([makeBranch('current')]).nodes;
    const destinations = nodes.map(effectBranchDestination);
    expect(destinations.map(({ nodeId, mixStage }) => [nodeId, mixStage])).toEqual([
      ['SOURCE_IMPORT', null],
      ['INFORMATION_EXTRACTION', null],
      ['PROMPT_GENERATION', null],
      ['SEGMENT_RENDER', null],
      ['TEMPLATE_MIX', 'TEMPLATE'],
      ['TEMPLATE_MIX', 'FILL'],
      ['TEMPLATE_MIX', 'PACKAGING'],
      ['FINAL_OUTPUT', null],
    ]);
    expect(destinations.every(({ workflowRunId }) => workflowRunId === 'current')).toBe(true);
    expect(destinations.slice(4).every(({ templateId }) => templateId === 'template-a')).toBe(true);
    expect(destinations.slice(0, 4).every(({ templateId }) => templateId === null)).toBe(true);
  });

  it('opens inherited nodes on their owning branch instead of whichever branch is currently active', () => {
    const parent = makeBranch('parent');
    parent.isActive = false;
    const child = makeBranch('child');
    child.parentWorkflowRunId = 'parent';
    child.forkNodeId = 'PROMPT_GENERATION';
    child.nodes[2]!.revision = 2;
    const nodes = buildEffectBranchLayout([parent, child]).nodes;
    expect(
      effectBranchDestination(nodes.find(({ nodeId }) => nodeId === 'SOURCE_IMPORT')!),
    ).toMatchObject({ workflowRunId: 'parent', nodeId: 'SOURCE_IMPORT' });
    expect(
      effectBranchDestination(
        nodes.find(
          ({ nodeId, workflowRunId }) =>
            nodeId === 'PROMPT_GENERATION' && workflowRunId === 'child',
        )!,
      ),
    ).toMatchObject({ workflowRunId: 'child', nodeId: 'PROMPT_GENERATION' });
  });

  it('does not apply a pending template destination to another project or branch', () => {
    const target = {
      projectId: 'project-a',
      ...effectBranchDestination({
        workflowRunId: 'run-a',
        nodeId: 'TEMPLATE_MIX',
        templateId: 'template-a',
        stageKey: 'MIX_FILL',
      }),
    };
    expect(effectBranchNavigationMatches(target, 'project-a', 'run-a')).toBe(true);
    expect(effectBranchNavigationMatches(target, 'project-b', 'run-a')).toBe(false);
    expect(effectBranchNavigationMatches(target, 'project-a', 'run-b')).toBe(false);
    expect(effectBranchNavigationMatches(null, 'project-a', 'run-a')).toBe(false);
  });
});
