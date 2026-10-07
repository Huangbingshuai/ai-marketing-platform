/** Reuse the normal exit/save boundary before binding a project from the read-only library. */
export async function enterLibraryProject(
  projectId: string,
  context: {
    currentProjectId: () => string;
    leaveCurrent: () => Promise<boolean>;
    selectProject: (projectId: string) => void;
    changingWorkflow: boolean;
  },
): Promise<boolean> {
  if (!projectId) return false;
  const current = context.currentProjectId();
  if (current && (current !== projectId || context.changingWorkflow)) {
    if (!(await context.leaveCurrent())) return false;
    if (context.currentProjectId()) return false;
  }
  context.selectProject(projectId);
  return context.currentProjectId() === projectId;
}
