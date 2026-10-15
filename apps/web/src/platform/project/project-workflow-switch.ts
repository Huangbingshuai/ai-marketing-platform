import type { AssetWorkflow } from '@ai-marketing/contracts';

/** Save the visible draft before activating the target workflow's own project binding. */
export async function switchProjectWorkflow(
  workflow: AssetWorkflow,
  context: {
    flushPendingEdits: () => Promise<boolean | undefined>;
    activateWorkflow: (workflow: AssetWorkflow) => void;
  },
): Promise<boolean> {
  if ((await context.flushPendingEdits()) === false) return false;
  context.activateWorkflow(workflow);
  return true;
}
