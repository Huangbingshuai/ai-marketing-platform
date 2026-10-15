/** Save on same-project navigation; only a different project requires the exit boundary. */
export async function enterLibraryProject(
  projectId: string,
  context: {
    currentProjectId: () => string;
    leaveCurrent: () => Promise<boolean>;
    flushCurrent: () => Promise<boolean>;
    selectProject: (projectId: string) => void;
    changingWorkflow: boolean;
  },
): Promise<boolean> {
  if (!projectId) return false;
  const current = context.currentProjectId();
  if (current && current !== projectId) {
    if (!(await context.leaveCurrent())) return false;
    if (context.currentProjectId()) return false;
  } else if (current && context.changingWorkflow) {
    if (!(await context.flushCurrent())) return false;
  }
  context.selectProject(projectId);
  return context.currentProjectId() === projectId;
}
