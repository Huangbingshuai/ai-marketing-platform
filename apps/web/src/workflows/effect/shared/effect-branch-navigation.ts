import type { EffectWorkflowBranchNodeId } from '@ai-marketing/contracts';

/** UI-only destination; it identifies a page, never a generation or submission request. */
export interface EffectBranchNavigation {
  projectId: string;
  workflowRunId: string;
  nodeId: EffectWorkflowBranchNodeId;
  templateId: string | null;
  mixStage: 'TEMPLATE' | 'FILL' | 'PACKAGING' | null;
}

export const effectBranchDestination = (node: {
  workflowRunId: string;
  nodeId: EffectWorkflowBranchNodeId;
  templateId: string | null;
  stageKey: string;
}): Omit<EffectBranchNavigation, 'projectId'> => ({
  workflowRunId: node.workflowRunId,
  nodeId: node.nodeId,
  templateId: node.templateId,
  mixStage:
    node.nodeId !== 'TEMPLATE_MIX'
      ? null
      : node.stageKey === 'MIX_PACKAGING'
        ? 'PACKAGING'
        : node.stageKey === 'MIX_FILL'
          ? 'FILL'
          : 'TEMPLATE',
});

export const effectBranchNavigationMatches = (
  target: EffectBranchNavigation | null | undefined,
  projectId: string,
  workflowRunId: string,
): target is EffectBranchNavigation =>
  Boolean(target && target.projectId === projectId && target.workflowRunId === workflowRunId);

/** Keep the selected template on the exact branch when moving from mix to output. */
export const effectTemplateStepNavigation = (
  projectId: string,
  workflowRunId: string,
  currentStep: number,
  nextStep: number,
  templateId: string | null,
): EffectBranchNavigation | null =>
  currentStep === 4 && nextStep === 5 && templateId
    ? { projectId, workflowRunId, templateId, nodeId: 'FINAL_OUTPUT', mixStage: null }
    : null;
