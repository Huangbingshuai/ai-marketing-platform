import { describe, expect, it, vi } from 'vitest';
import { useProjectDeletionRequests } from './project-deletion-requests';
import drawer from '../asset/AssetDrawer.vue?raw';
import page from './ProjectManagementPage.vue?raw';

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('project deletion submission isolation', () => {
  it('allows independent requests and releases only the acknowledged project', async () => {
    const requests = useProjectDeletionRequests();
    const a = deferred();
    const b = deferred();
    const first = requests.submit('a', () => a.promise);
    const second = requests.submit('b', () => b.promise);
    expect(requests.pendingIds.value).toEqual(['a', 'b']);
    expect(requests.isPending('unrelated')).toBe(false);
    b.resolve('queued-b');
    expect(await second).toBe('queued-b');
    expect(requests.pendingIds.value).toEqual(['a']);
    a.resolve('queued-a');
    expect(await first).toBe('queued-a');
    expect(requests.pendingIds.value).toEqual([]);
  });

  it('suppresses duplicate submissions while allowing retry after failure', async () => {
    const requests = useProjectDeletionRequests();
    const a = deferred();
    const b = deferred();
    const first = requests.submit('a', () => a.promise);
    const second = requests.submit('b', () => b.promise);
    const duplicate = vi.fn(async () => 'unexpected');
    expect(await requests.submit('a', duplicate)).toBeUndefined();
    expect(duplicate).not.toHaveBeenCalled();
    const failed = expect(first).rejects.toThrow('offline');
    a.reject(new Error('offline'));
    await failed;
    expect(requests.pendingIds.value).toEqual(['b']);
    expect(await requests.submit('a', async () => 'retry-queued')).toBe('retry-queued');
    expect(requests.isPending('b')).toBe(true);
    b.resolve('done');
    await second;
  });

  it('wires per-project protection without propagating deletion into global busy state', () => {
    expect(page).toContain(':entry-busy="projectEntryBusy"');
    expect(page).toContain(':deleting-project-ids="deletingProjectIds"');
    expect(page).toContain('deletionRequests.isPending(projectId)');
    expect(drawer).toMatch(/submittingDeletion\(project\)\s*\|\|\s*Boolean\(project\.deletion\)/);
    expect(drawer).toContain('props.deletingProjectIds.includes(project.id)');
    expect(drawer).not.toContain('deletionBusy');
    expect(page).not.toContain('deletionBusy');
    expect(page).toContain('@deletions-changed="refreshProjectsInBackground"');
    expect(page).toContain(
      'const refreshProjectsInBackground = (): Promise<void> => loadProjects(true)',
    );
    expect(page).toMatch(/if \(!background\) \{\s*projectsLoading.value = true;/);
    const refresh = drawer.split('() => props.refreshToken,')[1]?.split('watch(')[0];
    expect(refresh).toContain('if (props.open && !selectedProject.value) void loadProjects(true)');
    expect(refresh).not.toContain('selectedProject.value = null');
    expect(refresh).not.toContain('.focus()');
  });
});
