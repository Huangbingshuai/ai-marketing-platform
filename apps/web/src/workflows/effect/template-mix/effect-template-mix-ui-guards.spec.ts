import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import page from './EffectTemplateMixNodePage.vue?raw';
import { executeVueDeclarations } from './__tests__/vue-source';

type PackagingState = {
  workflowRunId: string;
  variantId: string;
  operation?: string;
  status: string;
};

const setup = () => {
  const state = {
    computed,
    props: { workflowRunId: 'current-run' },
    pendingPackagingVariantId: ref(''),
    packagingResults: ref<PackagingState[]>([]),
    runSwitching: ref(false),
    activeEntry: ref<{ aiFillLocked?: boolean }>({}),
    activeAiRun: ref<{ operation: string } | null>(null),
    fillStartPending: ref(false),
    packagingSourceAutoLocked: ref(false),
    sourceUpdateBusy: ref(false),
    selectedSourceUpdateLocked: ref(false),
    packagingPreviewReadOnly: ref(false),
    selectedVariant: ref({ id: 'film-a' }),
  };
  const guards = executeVueDeclarations(
    page,
    [
      'variantPackagingLocked',
      'workspaceTaskLocked',
      'projectEditLocked',
      'templateEditLocked',
      'voiceSelectLocked',
    ],
    state,
  );
  return { state, guards };
};

describe('workbench lock guards execute the production declarations', () => {
  it.each(['QUEUED', 'RUNNING'])('locks only the %s in-place packaging target', (status) => {
    const { state, guards } = setup();
    state.packagingResults.value = [
      {
        workflowRunId: 'current-run',
        variantId: 'film-a',
        operation: 'SINGLE_PACKAGE',
        status,
      },
    ];
    expect(guards.workspaceTaskLocked.value).toBe(false);
    expect(guards.variantPackagingLocked('film-a')).toBe(true);
    expect(guards.variantPackagingLocked('film-b')).toBe(false);
    expect(guards.projectEditLocked.value).toBe(true);
    expect(guards.templateEditLocked.value).toBe(true);
    expect(guards.voiceSelectLocked.value).toBe(true);
    state.selectedVariant.value = { id: 'film-b' };
    expect(guards.projectEditLocked.value).toBe(false);
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('releases the target on %s', (status) => {
    const { state, guards } = setup();
    state.packagingResults.value = [
      {
        workflowRunId: 'current-run',
        variantId: 'film-a',
        operation: 'BATCH_PACKAGE',
        status: 'RUNNING',
      },
    ];
    expect(guards.projectEditLocked.value).toBe(true);
    state.packagingResults.value[0]!.status = status;
    expect(guards.variantPackagingLocked('film-a')).toBe(false);
    expect(guards.projectEditLocked.value).toBe(false);
    expect(guards.templateEditLocked.value).toBe(false);
    expect(guards.voiceSelectLocked.value).toBe(false);
  });

  it('does not lock the parent for a background packaging branch with identical film IDs', () => {
    const { state, guards } = setup();
    state.packagingResults.value = [
      {
        workflowRunId: 'child-run',
        variantId: 'film-a',
        operation: 'BATCH_PACKAGE',
        status: 'RUNNING',
      },
    ];
    expect(guards.variantPackagingLocked('film-a')).toBe(false);
    expect(guards.projectEditLocked.value).toBe(false);
    expect(guards.templateEditLocked.value).toBe(false);
    expect(guards.voiceSelectLocked.value).toBe(false);
  });

  it('locks a single pending submission without locking other films', () => {
    const { state, guards } = setup();
    state.pendingPackagingVariantId.value = 'film-a';
    expect(guards.projectEditLocked.value).toBe(true);
    expect(guards.variantPackagingLocked('film-b')).toBe(false);
    state.pendingPackagingVariantId.value = '';
    expect(guards.projectEditLocked.value).toBe(false);
  });

  it('retains confirmed-fill locking but does not blanket-lock unrelated films during APPEND', () => {
    const { state, guards } = setup();
    state.activeAiRun.value = { operation: 'FILL' };
    expect(guards.projectEditLocked.value).toBe(true);
    state.activeAiRun.value = { operation: 'APPEND' };
    expect(guards.projectEditLocked.value).toBe(false);
    state.selectedSourceUpdateLocked.value = true;
    expect(guards.projectEditLocked.value).toBe(true);
    state.selectedSourceUpdateLocked.value = false;
    state.activeEntry.value = { aiFillLocked: true };
    expect(guards.projectEditLocked.value).toBe(true);
  });

  it('retains preview-readonly and source-update protection independently of packaging', () => {
    const { state, guards } = setup();
    state.packagingPreviewReadOnly.value = true;
    expect(guards.projectEditLocked.value).toBe(true);
    state.packagingPreviewReadOnly.value = false;
    state.sourceUpdateBusy.value = true;
    expect(guards.projectEditLocked.value).toBe(false);
    expect(guards.templateEditLocked.value).toBe(true);
    expect(guards.voiceSelectLocked.value).toBe(true);
  });
});
