import { describe, expect, it, vi } from 'vitest';

import { EffectPromptService } from './effect-prompt.service';

describe('EffectPromptService settings contract', () => {
  it('returns the shared settingsRevision field after CAS save', async () => {
    const repository = {
      workflowRun: vi.fn().mockResolvedValue({ id: 'workflow-a' }),
      products: vi.fn().mockResolvedValue([{ id: 'product-a' }]),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const savedAt = new Date('2026-08-25T00:00:00.000Z');
    const workingRepository = {
      saveNodeState: vi.fn().mockResolvedValue({
        conflict: false,
        unchanged: false,
        record: { revision: 7, savedAt },
      }),
    };
    const service = new EffectPromptService(
      repository as never,
      projects as never,
      workingRepository as never,
    );

    await expect(
      service.saveSettings('project-a', 'product-a', 'workflow-a', 6, {
        count: 50,
        durationSeconds: 15,
        semanticLimit: 15,
        visualLimit: 20,
      }),
    ).resolves.toEqual({
      productId: 'product-a',
      settings: { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
      settingsRevision: 7,
      unchanged: false,
      savedAt: savedAt.toISOString(),
    });
  });
});
