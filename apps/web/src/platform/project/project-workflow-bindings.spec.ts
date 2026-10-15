import type { Project } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import { useWorkflowProjectBindings } from './project-workflow-bindings';
import { workflowProjectStorageKey } from './project-context';

function storageFixture(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
const projects = [{ id: 'effect-a' }, { id: 'customized-b' }, { id: 'customized-c' }] as Project[];
const legacyKey = 'ai-marketing.current-project-id';

describe('shared project context with workflow-scoped bindings', () => {
  it('restores both projects after refresh without using a stale global binding', () => {
    const storage = storageFixture({
      [workflowProjectStorageKey('EFFECT')]: 'effect-a',
      [workflowProjectStorageKey('CUSTOMIZED')]: 'customized-b',
      [legacyKey]: 'customized-c',
    });
    const state = useWorkflowProjectBindings(storage, 'CUSTOMIZED');
    state.reconcile(projects);
    expect(state.ids).toEqual({ EFFECT: 'effect-a', CUSTOMIZED: 'customized-b', FISSION: '' });
    expect(storage.getItem(legacyKey)).toBeNull();
    const refreshed = useWorkflowProjectBindings(storage, 'EFFECT');
    refreshed.reconcile(projects);
    expect(refreshed.ids).toEqual(state.ids);
  });

  it('exits and replaces only one workflow, keeping the other protected from deletion', () => {
    const storage = storageFixture();
    const state = useWorkflowProjectBindings(storage, 'EFFECT');
    state.select('EFFECT', 'effect-a');
    state.select('CUSTOMIZED', 'customized-b');
    expect(state.isBound('effect-a')).toBe(true);
    expect(state.isBound('customized-b')).toBe(true);
    expect(state.isBound('')).toBe(false);
    state.select('CUSTOMIZED', '');
    state.reconcile(projects);
    expect(state.ids.EFFECT).toBe('effect-a');
    expect(state.ids.CUSTOMIZED).toBe('');
    expect(state.isBound('customized-b')).toBe(false);
    state.select('CUSTOMIZED', 'customized-c');
    expect(state.ids.EFFECT).toBe('effect-a');
    expect(state.ids.CUSTOMIZED).toBe('customized-c');
    expect(useWorkflowProjectBindings(storage, 'CUSTOMIZED').ids).toEqual(state.ids);
  });

  it('clears unavailable bindings without choosing another project or resurrecting an exited one', () => {
    const storage = storageFixture({
      [workflowProjectStorageKey('EFFECT')]: 'effect-a',
      [workflowProjectStorageKey('CUSTOMIZED')]: 'missing',
      [legacyKey]: 'customized-b',
    });
    const state = useWorkflowProjectBindings(storage, 'CUSTOMIZED');
    state.reconcile(
      projects.map((project) =>
        project.id === 'effect-a'
          ? { ...project, deletion: { status: 'QUEUED', phase: 'DATABASE' } }
          : project,
      ),
    );
    expect(state.ids).toEqual({ EFFECT: '', CUSTOMIZED: '', FISSION: '' });
    expect(useWorkflowProjectBindings(storage, 'EFFECT').ids).toEqual(state.ids);
  });

  it('migrates a legacy-only selection once to the initial workflow', () => {
    const storage = storageFixture({ [legacyKey]: 'effect-a' });
    const state = useWorkflowProjectBindings(storage, 'EFFECT');
    state.reconcile(projects);
    expect(state.ids).toEqual({ EFFECT: 'effect-a', CUSTOMIZED: '', FISSION: '' });
    state.select('EFFECT', '');
    expect(useWorkflowProjectBindings(storage, 'CUSTOMIZED').ids.EFFECT).toBe('');
  });
});
