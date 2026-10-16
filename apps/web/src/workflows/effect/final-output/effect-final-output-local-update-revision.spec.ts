import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import page from './EffectFinalOutputNodePage.vue?raw';
import { executeVueDeclarations } from '../template-mix/__tests__/vue-source';

function harness() {
  const state = {
    props: { projectId: 'project', workflowRunId: 'path' },
    mounted: true,
    run: ref({
      id: 'output',
      items: [{ id: 'film', stale: true }],
      projectChanges: { draftRevision: 10, added: [], removedItemIds: [] },
    }),
    canLocalUpdate: ref(true),
    busy: ref(false),
    error: ref(''),
    refresh: vi.fn(async () => {
      state.run.value.projectChanges.draftRevision = 11;
      return true;
    }),
    requestActionConfirmation: vi.fn(async () => true),
    requestJson: vi.fn(async () => ({})),
  };
  const { localUpdate } = executeVueDeclarations(page, ['localUpdate'], state);
  return { state, localUpdate: localUpdate as (ids: string[], sync?: boolean) => Promise<void> };
}

describe('local output update confirms the latest saved revision', () => {
  it('refreshes before confirmation and posts the fresh revision rather than the retained page snapshot', async () => {
    const { state, localUpdate } = harness();
    state.requestActionConfirmation.mockImplementation(async () => {
      expect(state.refresh).toHaveBeenCalledOnce();
      expect(state.busy.value).toBe(true);
      return true;
    });
    await localUpdate(['film'], true);
    expect(state.requestJson).toHaveBeenCalledWith(
      '/projects/project/workflows/effect/final-output/output/local-update',
      expect.objectContaining({
        body: { itemIds: ['film'], syncProjects: true, expectedDraftRevision: 11 },
      }),
    );
    expect(state.busy.value).toBe(false);
  });

  it.each(['project', 'template', 'already-current', 'failed-read', 'superseded-read'])(
    'does not confirm or write when the refreshed target became %s',
    async (change) => {
      const { state, localUpdate } = harness();
      state.refresh.mockImplementation(async () => {
        if (change === 'project') state.props.projectId = 'other';
        if (change === 'template') state.run.value.id = 'other-output';
        if (change === 'already-current') state.canLocalUpdate.value = false;
        if (change === 'failed-read') state.error.value = '读取失败';
        return change !== 'superseded-read';
      });
      await localUpdate(['film']);
      expect(state.requestActionConfirmation).not.toHaveBeenCalled();
      expect(state.requestJson).not.toHaveBeenCalled();
      expect(state.busy.value).toBe(false);
    },
  );

  it('keeps server conflict protection for changes made after confirmation and never force-retries', async () => {
    const { state, localUpdate } = harness();
    state.requestJson.mockRejectedValue(new Error('草稿在确认后已更新'));
    await localUpdate(['film']);
    expect(state.requestJson).toHaveBeenCalledOnce();
    expect(state.error.value).toBe('草稿在确认后已更新');
    expect(state.busy.value).toBe(false);
  });
});
