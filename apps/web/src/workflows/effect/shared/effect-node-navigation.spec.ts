import { describe, expect, it } from 'vitest';
import { completeEffectNodeHandoff, flushEffectNodeNavigation } from './effect-node-navigation';
import {
  isPromptWorkspaceScopeReady,
  resolvePromptTransitionValue,
} from '../prompt-generation/effect-prompt-generation-state';
import promptSource from '../prompt-generation/EffectPromptGenerationNodePage.vue?raw';
import renderSource from '../segment-render/EffectSegmentRenderNodePage.vue?raw';
import parentSource from '../source-import/EffectImportNodePage.vue?raw';

describe('effect editing node navigation', () => {
  it('keeps batch export clickable and accepts clicks during a handoff without dropping them', () => {
    const button = promptSource.split('@click="exportBatch"')[0]!.split('<button').at(-1)!;
    expect(button).not.toContain(':disabled');
    expect(button).toContain(':aria-busy="exporting"');
    const handler = promptSource
      .split('const exportBatch =')[1]!
      .split('const validatePromptBatch')[0]!;
    expect(handler).not.toContain('workspaceSynchronizing.value');
    expect(handler).not.toContain('resultLoading.value');
    expect(handler).not.toContain('editPending.value');
    expect(handler).not.toContain('currentRunning.value');
    expect(handler).toContain('if (batchExportPending) return;');
    expect(handler.indexOf('await runSynchronization')).toBeLessThan(
      handler.indexOf('downloadEffectPromptBatch('),
    );
    expect(handler).toContain('result.resultId !== state.resultId');
    expect(handler).toContain('result.projectId !== projectId');
    expect(handler).toContain('batchExportPending = false;');
  });
  it('does not finish a handoff at parent installation while node data is still loading', async () => {
    let install!: () => void;
    let finishRead!: () => void;
    const parent = new Promise<void>((resolve) => {
      install = resolve;
    });
    let latest: Promise<void> | null = null;
    let settled = false;
    const handoff = completeEffectNodeHandoff(
      () => parent,
      () => latest,
    ).then(() => {
      settled = true;
    });
    latest = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    install();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRead();
    await handoff;
    expect(settled).toBe(true);
  });
  it('waits for a replacement node read instead of releasing controls after an aborted read', async () => {
    let finishFirst!: () => void;
    let finishReplacement!: () => void;
    let latest = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let settled = false;
    const handoff = completeEffectNodeHandoff(
      async () => undefined,
      () => latest,
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    latest = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    finishFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishReplacement();
    await handoff;
    expect(settled).toBe(true);
  });
  it('keeps the source control mode until the complete edit handoff settles', () => {
    const synchronization = promptSource
      .split('const synchronizeEditRun =')[1]!
      .split('const exporting')[0]!;
    expect(synchronization).toContain('completeEffectNodeHandoff(');
    expect(synchronization).toContain('() => activeWorkspaceLoad');
    expect(promptSource).toContain('v-if="hasConfirmedPrompt && !displayEditing"');
    expect(promptSource).toContain('v-else-if="displayEditing"');
    expect(promptSource).toContain("editTransition === 'cancel' ? '正在退出…' : '取消编辑'");
  });
  it('keeps save visible and does not turn same-scope background reads into edit locks', () => {
    const permission = promptSource
      .split('const canEditPrompt =')[1]!
      .split('const canEnterPromptEdit')[0]!;
    expect(permission).not.toContain('workspaceSynchronizing');
    expect(permission).not.toContain('resultLoading');
    expect(permission).toContain('loadedWorkspaceContext.value');
    expect(permission).toContain('loadedResultContext.value');
    expect(permission).toContain('resultData.value?.resultId === currentState.value?.resultId');
    expect(permission).toContain('!editPending.value');
    expect(permission).toContain('!validating.value');
    expect(permission).toContain('!editorSaving.value');
    expect(permission).toContain('itemOperation.value === null');
    expect(promptSource).toContain(
      'v-if="displayEditing || (!editTransition && !hasConfirmedPrompt)"',
    );
    expect(promptSource).not.toContain('v-if="canEditPrompt"');
    const fence = promptSource
      .split('const invalidatePromptReadRequests =')[1]!
      .split('const commitEditor')[0]!;
    expect(fence).toContain('workspaceController?.abort()');
    expect(fence).toContain('resultController?.abort()');
    expect(fence).toContain('workspaceGeneration += 1');
    expect(fence).toContain('resultGeneration += 1');
    for (const [start, end, busy] of [
      ['const commitEditor =', 'const requestDeleteItem', 'editorSaving.value = true'],
      ['const requestDeleteItem =', 'const exportBatch', 'itemOperation.value = {'],
      ['const validatePromptBatch =', 'const beginPromptEdit', 'validating.value = true'],
    ]) {
      const operation = promptSource.split(start!)[1]!.split(end!)[0]!;
      expect(operation.indexOf('invalidatePromptReadRequests()')).toBeGreaterThan(-1);
      expect(operation.indexOf('invalidatePromptReadRequests()')).toBeLessThan(
        operation.indexOf(busy!),
      );
    }
  });
  it('retains the product while an edit handoff remaps IDs, then uses the new loaded value', () => {
    const scope = { projectId: 'a', workflowRunId: 'edit' };
    const original = { id: 'old-product' };
    const transition = { ...scope, value: original };
    expect(resolvePromptTransitionValue(null, transition, scope)).toBe(original);
    const cloned = { id: 'new-product' };
    expect(resolvePromptTransitionValue(cloned, transition, scope)).toBe(cloned);
    expect(resolvePromptTransitionValue(null, null, scope)).toBeNull();
    expect(resolvePromptTransitionValue(null, transition, { ...scope, projectId: 'b' })).toBeNull();
    expect(
      resolvePromptTransitionValue(null, transition, { ...scope, workflowRunId: 'other' }),
    ).toBeNull();
    // Cancelling uses a distinct explicit handoff back to the parent, not arbitrary cached data.
    const parentScope = { ...scope, workflowRunId: 'parent' };
    expect(resolvePromptTransitionValue(null, { ...parentScope, value: cloned }, parentScope)).toBe(
      cloned,
    );
  });
  it('keeps the transition view until workspace and result finish loading and parallelizes parent reads', () => {
    const synchronize = promptSource
      .split('const synchronizeEditRun =')[1]!
      .split('const exporting')[0]!;
    expect(synchronize.indexOf('transitionView.value =')).toBeLessThan(
      synchronize.indexOf("emit('branchActivated'"),
    );
    const loader = promptSource
      .split('async function readPromptWorkspace')[1]!
      .split('const productSignature')[0]!;
    expect(loader.indexOf('await loadCurrentResult(prefetchedResult)')).toBeLessThan(
      loader.indexOf('transitionView.value = null'),
    );
    expect(loader).toContain('const [snapshot, prefetchedResult] = await Promise.all([');
    expect(loader).toContain('transitionView.value.workflowRunId === loadedContext.workflowRunId');
    expect(promptSource).toContain('prefetched?.key === resultViewKey(productId)');
    expect(loader).toContain('if (generation === workspaceGeneration)');
    const refresh = parentSource
      .split('const activeRunRefreshQueue =')[1]!
      .split('const refreshActiveRunInPlace')[0]!;
    expect(refresh).toContain(
      'const [workspaceResponse, initialDraftResponse, overview] = await Promise.all([',
    );
    expect(refresh).toContain('nextWorkspace.drafts.SINGLE.id !== draftResponse.data.id');
    expect(refresh).toContain('if (refreshBranchTree) scheduleAdjacentWorkspacePrefetch();');
    expect(synchronize).toContain('refreshBranchTree = false');
    expect(promptSource).toContain('await synchronizeEditRun(nextRunId, true)');
  });
  it('allows a warm same-Run snapshot during background refresh but not a different scope', () => {
    const current = { projectId: 'project-a', workflowRunId: 'run-a' };
    expect(isPromptWorkspaceScopeReady('ready', current, current)).toBe(true);
    expect(isPromptWorkspaceScopeReady('loading', current, current)).toBe(false);
    expect(isPromptWorkspaceScopeReady('error', current, current)).toBe(false);
    expect(isPromptWorkspaceScopeReady('ready', null, current)).toBe(false);
    expect(
      isPromptWorkspaceScopeReady('ready', { ...current, workflowRunId: 'run-b' }, current),
    ).toBe(false);
    expect(
      isPromptWorkspaceScopeReady('ready', { ...current, projectId: 'project-b' }, current),
    ).toBe(false);
    const canEnter = promptSource
      .split('const canEnterPromptEdit =')[1]!
      .split('const canEditSettings')[0]!;
    expect(canEnter).not.toContain('workspaceSynchronizing');
    expect(promptSource).toContain(':disabled="!canEnterPromptEdit"');
    const begin = promptSource
      .split('const beginPromptEdit =')[1]!
      .split('const cancelPromptEdit')[0]!;
    expect(begin.indexOf('workspaceController?.abort()')).toBeLessThan(
      begin.indexOf('await beginEffectWorkflowNodeEdit('),
    );
    expect(begin).toContain('workspaceGeneration += 1');
  });
  it('allows leaving an abortable read-only workspace load', async () => {
    expect(await flushEffectNodeNavigation(null, () => false)).toBe(true);
    const renderFlush = renderSource
      .split('const flushPendingEdits =')[1]!
      .split('defineExpose')[0]!;
    expect(renderFlush).toContain('flushEffectNodeNavigation(');
    expect(renderFlush).toContain('editRequestPending.value');
    expect(renderFlush).not.toContain('editTransitioning.value');
    expect(renderFlush).not.toContain('workspaceSynchronizing.value');
  });

  it('waits for an in-flight Run handoff instead of reporting a failed save', async () => {
    let settle!: () => void;
    const synchronization = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const navigation = flushEffectNodeNavigation(synchronization, () => false).then((allowed) => {
      settled = true;
      return allowed;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    settle();
    expect(await navigation).toBe(true);
  });

  it('checks actual writes after handoff and continues protecting saves', async () => {
    let settle!: () => void;
    const synchronization = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let writing = false;
    const navigation = flushEffectNodeNavigation(synchronization, () => writing);
    writing = true;
    settle();
    expect(await navigation).toBe(false);
    expect(await flushEffectNodeNavigation(null, () => true)).toBe(false);
  });

  it('keeps Prompt mounted and uses the parent editing state without a second overview read', () => {
    expect(parentSource).toContain(':key="`prompt:${currentProjectId}`"');
    expect(parentSource).not.toContain(
      ':key="`prompt:${currentProjectId}:${workspace?.workflowRunId',
    );
    expect(parentSource).toContain('@branch-activated="handlePromptWorkflowRunChange"');
    expect(promptSource).toContain('const editing = computed(() => Boolean(props.editing))');
    expect(promptSource).not.toContain('getActiveWorkflowRunOverview');
    expect(promptSource).toContain('await synchronizeEditRun(session.data.run.id)');
    expect(promptSource).toContain("void reloadWorkspace(status.value !== 'ready')");
    expect(promptSource).toContain('if (expectedEditRunId === props.workflowRunId) return;');
    expect(parentSource).toContain('void prefetchEffectPromptWorkspace({');
  });

  it('does not save batch settings on leaving an editing or hydrating view', () => {
    const flush = promptSource.split('const flushPendingEdits =')[1]!.split('defineExpose')[0]!;
    expect(flush).toContain('if (editing.value || workspaceSynchronizing.value) return true;');
    expect(flush).toContain('runSynchronization');
    const cleanup = promptSource.split('const stopNodeRequests =')[1]!.split('onActivated')[0]!;
    expect(cleanup).toContain('clearTimeout(settingsTimer)');
    expect(cleanup).toContain('clearTimeout(searchTimer)');
    const resume = promptSource
      .split('const resumeRuns =')[1]!
      .split('function reloadWorkspace')[0]!;
    expect(resume).toContain('workflowRunId === props.workflowRunId');
    expect(resume).toContain('generation === workspaceGeneration');
    expect(resume).toContain('if (!isCurrent()');
    const resultLoader = promptSource
      .split('const loadCurrentResult =')[1]!
      .split('const updateRun')[0]!;
    expect(resultLoader).toContain('!nodeActive ||');
    expect(resultLoader).toContain('loadedWorkspaceContext.value?.projectId !== props.projectId');
    expect(resultLoader).toContain(
      'loadedWorkspaceContext.value.workflowRunId !== props.workflowRunId',
    );
  });
});
