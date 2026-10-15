import type { AssetWorkflow, Project } from '@ai-marketing/contracts';
import { reactive } from 'vue';
import { resolveBoundProjectId, workflowProjectStorageKey } from './project-context';

const WORKFLOWS = ['EFFECT', 'CUSTOMIZED', 'FISSION'] as const;
const LEGACY_KEY = 'ai-marketing.current-project-id';

/** One shared project context, with an independent binding for each workflow. */
export function useWorkflowProjectBindings(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  initialWorkflow: AssetWorkflow,
) {
  const ids = reactive<Record<AssetWorkflow, string>>({
    EFFECT: storage.getItem(workflowProjectStorageKey('EFFECT')) ?? '',
    CUSTOMIZED: storage.getItem(workflowProjectStorageKey('CUSTOMIZED')) ?? '',
    FISSION: storage.getItem(workflowProjectStorageKey('FISSION')) ?? '',
  });
  // The old global key may seed only the initially visible workflow, never another binding.
  if (!WORKFLOWS.some((workflow) => ids[workflow]))
    ids[initialWorkflow] = storage.getItem(LEGACY_KEY) ?? '';

  function select(workflow: AssetWorkflow, projectId: string): void {
    ids[workflow] = projectId;
    const key = workflowProjectStorageKey(workflow);
    if (projectId) storage.setItem(key, projectId);
    else storage.removeItem(key);
  }

  function reconcile(projects: readonly Project[]): void {
    for (const workflow of WORKFLOWS)
      select(workflow, resolveBoundProjectId(projects, ids[workflow], ''));
    storage.removeItem(LEGACY_KEY);
  }

  function isBound(projectId: string): boolean {
    return Boolean(projectId) && WORKFLOWS.some((workflow) => ids[workflow] === projectId);
  }

  return { ids, select, reconcile, isBound };
}
