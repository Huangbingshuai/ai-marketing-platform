import { afterEach, describe, expect, it, vi } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import {
  isMixWorkspaceSwitching,
  readMixWorkspaceWithDeadline,
} from './effect-template-mix-workspace-load';

afterEach(() => vi.useRealTimers());

describe('mix workspace branch loading', () => {
  it('does not treat queued tasks, publication waits or a same-Run refresh as a switch', () => {
    expect(isMixWorkspaceSwitching(null, 'project:parent', 'project:parent')).toBe(false);
    expect(isMixWorkspaceSwitching('project:parent', 'project:parent', 'project:parent')).toBe(
      false,
    );
    expect(isMixWorkspaceSwitching(null, 'project:parent', 'project:child')).toBe(false);
  });
  it('only shows the current request until that exact workspace is installed', () => {
    expect(isMixWorkspaceSwitching('project:child', 'project:parent', 'project:child')).toBe(true);
    expect(isMixWorkspaceSwitching('project:child', 'project:child', 'project:child')).toBe(false);
    expect(isMixWorkspaceSwitching('project:child', 'other:child', 'project:child')).toBe(true);
    expect(isMixWorkspaceSwitching('project:old', 'project:parent', 'project:child')).toBe(false);
  });
  it('returns successful reads and releases the deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    await expect(readMixWorkspaceWithDeadline(async () => 'workspace', controller)).resolves.toBe(
      'workspace',
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.signal.aborted).toBe(false);
  });
  it('releases failed reads without cancelling unrelated work', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    await expect(
      readMixWorkspaceWithDeadline(async () => {
        throw new Error('读取失败');
      }, controller),
    ).rejects.toThrow('读取失败');
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });
  it('bounds a stalled read and ignores its late success', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const task = readMixWorkspaceWithDeadline(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      controller,
    );
    const assertion = expect(task).rejects.toThrow('混剪工作区加载超时');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(controller.signal.aborted).toBe(true);
    finish('late workspace');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('settles an aborted old read without interfering with the newer request', async () => {
    vi.useFakeTimers();
    const old = new AbortController();
    const next = new AbortController();
    const previousTask = readMixWorkspaceWithDeadline(() => new Promise(() => {}), old);
    const assertion = expect(previousTask).rejects.toMatchObject({ name: 'AbortError' });
    old.abort();
    await assertion;
    await expect(readMixWorkspaceWithDeadline(async () => 'new workspace', next)).resolves.toBe(
      'new workspace',
    );
    expect(next.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start a read with an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();
    await expect(readMixWorkspaceWithDeadline(read, controller)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(read).not.toHaveBeenCalled();
  });
  it('keeps navigation callbacks from owning loading and prevents cross-Run draft writes', () => {
    expect(page).not.toContain('runSwitching.value =');
    expect(page).toContain(
      'if (requestController === controller) requestedWorkspaceScope.value = null;',
    );
    expect(page).toContain('installedWorkspaceScope.value !== currentWorkspaceScope.value');
    expect(page).toContain(
      'if (projectId !== props.projectId || workflowRunId !== props.workflowRunId) return false;',
    );
    const style = page.split('.mix-run-switch {')[1]!.split('}')[0]!;
    expect(style).not.toContain('inset: 0');
    expect(style).not.toContain('position: absolute');
    expect(style).toContain('pointer-events: none');
  });
});
