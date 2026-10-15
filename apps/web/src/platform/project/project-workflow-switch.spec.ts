import type { AssetWorkflow } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import { switchProjectWorkflow } from './project-workflow-switch';

function setup() {
  let workflow: AssetWorkflow = 'EFFECT';
  const ids: Record<AssetWorkflow, string> = {
    EFFECT: 'effect-a',
    CUSTOMIZED: 'customized-b',
    FISSION: '',
  };
  const events: string[] = [];
  const context = {
    flushPendingEdits: vi.fn(async (): Promise<boolean | undefined> => {
      events.push('save');
      return true;
    }),
    activateWorkflow: vi.fn((next: AssetWorkflow) => {
      events.push(next);
      workflow = next;
    }),
  };
  return {
    context,
    events,
    workflow: () => workflow,
    projectId: () => ids[workflow],
    ids,
    clearProject: () => {
      ids[workflow] = '';
    },
  };
}

describe('independent workflow project navigation', () => {
  it('saves before switching and restores each workflow project across repeated navigation', async () => {
    const h = setup();
    for (const next of ['CUSTOMIZED', 'EFFECT', 'CUSTOMIZED', 'FISSION', 'EFFECT'] as const) {
      expect(await switchProjectWorkflow(next, h.context)).toBe(true);
      expect(h.projectId()).toBe(
        next === 'EFFECT' ? 'effect-a' : next === 'CUSTOMIZED' ? 'customized-b' : '',
      );
      expect(h.workflow()).toBe(next);
      expect(h.events.slice(-2)).toEqual(['save', next]);
      expect(h.ids.EFFECT).toBe('effect-a');
      expect(h.ids.CUSTOMIZED).toBe('customized-b');
    }
  });
  it('does not switch on rejected or failed draft saving', async () => {
    const h = setup();
    h.context.flushPendingEdits.mockResolvedValue(false);
    expect(await switchProjectWorkflow('CUSTOMIZED', h.context)).toBe(false);
    h.context.flushPendingEdits.mockRejectedValue(new Error('save failed'));
    await expect(switchProjectWorkflow('CUSTOMIZED', h.context)).rejects.toThrow('save failed');
    expect(h.context.activateWorkflow).not.toHaveBeenCalled();
    expect(h.workflow()).toBe('EFFECT');
    expect(h.projectId()).toBe('effect-a');
  });
  it('waits for pending saves and does not resurrect a project removed while saving', async () => {
    const h = setup();
    let finish!: (value: boolean) => void;
    h.context.flushPendingEdits.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const switching = switchProjectWorkflow('CUSTOMIZED', h.context);
    expect(h.context.activateWorkflow).not.toHaveBeenCalled();
    h.ids.CUSTOMIZED = '';
    finish(true);
    expect(await switching).toBe(true);
    expect(h.projectId()).toBe('');
    expect(h.ids.EFFECT).toBe('effect-a');
  });
  it('supports an unbound workspace without creating or binding a project', async () => {
    const h = setup();
    h.ids.CUSTOMIZED = '';
    h.context.flushPendingEdits.mockResolvedValue(undefined);
    expect(await switchProjectWorkflow('CUSTOMIZED', h.context)).toBe(true);
    expect(h.projectId()).toBe('');
    expect(h.ids.EFFECT).toBe('effect-a');
  });
});
