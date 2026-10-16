type PendingPackagingNavigation = {
  runId: string;
  workflowRunId: string;
  variantId: string;
  createdAt: number;
};

const key = (projectId: string, sourceWorkflowRunId: string, templateId: string) =>
  `effect-packaging-navigation:${projectId}:${sourceWorkflowRunId}:${templateId}`;
const openedKey = (
  projectId: string,
  sourceWorkflowRunId: string,
  templateId: string,
  workflowRunId: string,
) => `effect-packaging-opened:${projectId}:${sourceWorkflowRunId}:${templateId}:${workflowRunId}`;
const openedInMemory = new Set<string>();

export const rememberPackagingNavigation = (
  projectId: string,
  sourceWorkflowRunId: string,
  templateId: string,
  runId: string,
  workflowRunId: string,
  variantId: string,
): void => {
  try {
    sessionStorage.setItem(
      key(projectId, sourceWorkflowRunId, templateId),
      JSON.stringify({ runId, workflowRunId, variantId, createdAt: Date.now() }),
    );
  } catch {
    // The active tab can still follow the task through its in-memory poller.
  }
};

export const pendingPackagingNavigation = (
  projectId: string,
  sourceWorkflowRunId: string,
  templateId: string,
): PendingPackagingNavigation | null => {
  const storageKey = key(projectId, sourceWorkflowRunId, templateId);
  try {
    const value = sessionStorage.getItem(storageKey);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PendingPackagingNavigation>;
    if (
      typeof parsed.runId === 'string' &&
      typeof parsed.workflowRunId === 'string' &&
      typeof parsed.variantId === 'string' &&
      typeof parsed.createdAt === 'number' &&
      Date.now() - parsed.createdAt < 24 * 60 * 60 * 1000
    )
      return parsed as PendingPackagingNavigation;
  } catch {
    // A corrupted or inaccessible marker must never redirect another workbench.
  }
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage may be disabled. */
  }
  return null;
};

export const forgetPackagingNavigation = (
  projectId: string,
  sourceWorkflowRunId: string,
  templateId: string,
  runId: string,
): void => {
  const pending = pendingPackagingNavigation(projectId, sourceWorkflowRunId, templateId);
  if (pending?.runId !== runId) return;
  try {
    sessionStorage.removeItem(key(projectId, sourceWorkflowRunId, templateId));
  } catch {
    // Storage may be disabled.
  }
};

export const hasOpenedPackagingBranch = (
  projectId: string,
  sourceWorkflowRunId: string,
  templateId: string,
  workflowRunId: string,
): boolean => {
  const storageKey = openedKey(projectId, sourceWorkflowRunId, templateId, workflowRunId);
  if (openedInMemory.has(storageKey)) return true;
  try {
    return localStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
};

export const markPackagingBranchOpened = (
  projectId: string,
  sourceWorkflowRunId: string,
  templateId: string,
  workflowRunId: string,
): void => {
  const storageKey = openedKey(projectId, sourceWorkflowRunId, templateId, workflowRunId);
  openedInMemory.add(storageKey);
  try {
    localStorage.setItem(storageKey, '1');
  } catch {
    /* Storage may be disabled. */
  }
};
