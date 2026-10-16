import { computed, reactive, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { transpileModule } from 'typescript';
import { PACKAGING_STAGE_LABELS, packagingPictureOnlyVariant } from '@ai-marketing/contracts';
import type {
  EffectTemplateMixVariant,
  PackagingItem,
  PackagingRun,
} from '@ai-marketing/contracts';
import { livePackagingItem, packagingProgress } from './effect-packaging-progress';
import panel from './EffectTemplateMixPackaging.vue?raw';

function evaluate<T>(source: string, context: Record<string, unknown>, result: string): T {
  const createEvaluator = new Function(
    ...Object.keys(context),
    `${transpileModule(source, {}).outputText}\nreturn ${result};`,
  );
  return createEvaluator(...Object.values(context)) as T;
}
function task(status: PackagingRun['status'], workflowRunId = 'parent', id = 'old'): PackagingRun {
  return {
    id,
    workflowRunId,
    templateId: 'template',
    operation: 'BATCH_PACKAGE',
    status,
    createdAt: id === 'old' ? '2026-10-11T00:00:00Z' : '2026-10-11T01:00:00Z',
    counts: { completed: 37, failed: 5, total: 42, shards: 11 },
    items: [
      {
        id: `${id}-item`,
        workflowRunId,
        runId: id,
        variantId: 'film',
        operation: 'BATCH_PACKAGE',
        status: status === 'PARTIAL' ? 'COMPLETED' : status,
        stage: 'VOICE',
        checkpoint: {},
      },
    ],
  } as PackagingRun;
}
function banner() {
  const starting = ref(false),
    startingVariantId = ref('');
  const backgroundRun = ref<PackagingRun | null>(task('PARTIAL'));
  const runs = ref<PackagingRun[]>([task('PARTIAL')]);
  const source = panel.slice(
    panel.indexOf('const batchSubmitting ='),
    panel.indexOf('const stageStates ='),
  );
  const state = evaluate<{
    batchProgressVisible: { value: boolean };
    progress: { value: number };
    batchActive: { value: boolean };
    progressSummary: { value: string };
    executionSummary: { value: string };
  }>(
    source,
    {
      computed,
      starting,
      startingVariantId,
      runs,
      displayedBackgroundRun: backgroundRun,
      run: computed(() => backgroundRun.value),
      active: ref(true),
      backgroundActive: ref(true),
      watch: vi.fn(),
      emit: vi.fn(),
      packagingProgress,
      PACKAGING_STAGE_LABELS,
      statusLabel: { QUEUED: '排队中', RUNNING: '处理中' },
    },
    '{ batchProgressVisible, batchActive, progress, progressSummary, executionSummary }',
  );
  return { starting, startingVariantId, backgroundRun, runs, ...state };
}

describe('batch banner belongs only to its active task', () => {
  it('does not reuse previous failures or counts during a fresh submission', () => {
    const h = banner();
    h.starting.value = true;
    expect(h.batchProgressVisible.value).toBe(true);
    expect(h.progress.value).toBe(0);
    expect(h.progressSummary.value).toContain('正在提交');
    expect(h.executionSummary.value).toBe('');
  });
  it.each(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const)(
    'hides terminal %s without status text',
    (status) => {
      const h = banner();
      h.backgroundRun.value = task(status);
      h.runs.value = [task(status)];
      expect(h.batchProgressVisible.value).toBe(false);
      expect(h.executionSummary.value).toBe('');
      expect(h.progressSummary.value).toBe('');
    },
  );
  it('lets a direct terminal response beat a late RUNNING history copy', () => {
    const h = banner();
    h.runs.value = [task('RUNNING')];
    expect(h.batchProgressVisible.value).toBe(false);
  });
  it('shows the accepted task instead of terminal history, without failure notices', () => {
    const h = banner();
    h.backgroundRun.value = task('RUNNING', 'child', 'new');
    h.backgroundRun.value.counts.completed = 0;
    expect(h.batchProgressVisible.value).toBe(true);
    expect(h.executionSummary.value).toContain('已完成 0 / 42');
    expect(h.executionSummary.value).not.toContain('失败');
    expect(h.progressSummary.value).toContain(PACKAGING_STAGE_LABELS.VOICE);
  });
  it('does not project a single task into batch progress', () => {
    const h = banner();
    h.backgroundRun.value = { ...task('RUNNING'), operation: 'SINGLE_PACKAGE' };
    expect(h.batchProgressVisible.value).toBe(false);
    h.starting.value = true;
    h.startingVariantId.value = 'film';
    expect(h.batchProgressVisible.value).toBe(false);
  });
  it('never shows automatic append packaging as a manual batch action or progress', () => {
    const h = banner();
    h.backgroundRun.value = null;
    h.runs.value = [{ ...task('RUNNING'), operation: 'APPEND_PACKAGE' }];
    expect(h.batchProgressVisible.value).toBe(false);
    expect(h.batchActive.value).toBe(false);
    expect(h.progressSummary.value).toBe('');
  });
  it('keeps failure statistics in the workflow dialog, not the workbench banner', () => {
    const bannerTemplate = panel.slice(
      panel.indexOf('<WorkflowRunProgress'),
      panel.indexOf('<dialog'),
    );
    expect(bannerTemplate).not.toContain(':warning=');
    expect(bannerTemplate).not.toContain('条失败');
    expect(panel).toContain('stageState(stage).summary');
  });
  it.each(['parent', 'child'])(
    'ends submission on acceptance in %s before the history refresh finishes',
    async (executionRunId) => {
      let finishRefresh!: () => void;
      const refresh = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve;
          }),
      );
      const h = banner();
      const emit = vi.fn();
      const create = evaluate<(id?: string) => Promise<void>>(
        `let generation = 0; let pendingCreate = null; let backgroundTimer;
       ${panel.slice(panel.indexOf('async function execute('), panel.indexOf('// Decode once'))}`,
        {
          ...h,
          busy: ref(false),
          requestError: ref(''),
          base: ref('/test'),
          props: {
            projectId: 'p',
            workflowRunId: 'parent',
            templateId: 'template',
            selectedVariantId: 'film',
            prepare: async () => 1,
          },
          emit,
          refresh,
          requestJson: vi.fn(async () => ({ data: task('RUNNING', executionRunId, 'new') })),
          rememberPackagingNavigation: vi.fn(),
          backgroundReader: { invalidate: vi.fn() },
          crypto: { randomUUID: () => 'key' },
          clearTimeout: vi.fn(),
          setTimeout: vi.fn(),
        },
        'create',
      );
      const pending = create();
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(h.starting.value).toBe(false);
      expect(h.backgroundRun.value?.workflowRunId).toBe(executionRunId);
      h.backgroundRun.value = task('COMPLETED', executionRunId, 'new');
      expect(h.batchProgressVisible.value).toBe(false);
      finishRefresh();
      await pending;
      expect(emit).toHaveBeenCalledWith('submissionSettled', 'template', 'parent');
    },
  );
});

describe('repackaging child cannot clear the original branch package', () => {
  it.each(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const)(
    'isolates a %s child with the same film ID',
    (status) => {
      const variant = {
        id: 'film',
        slots: [],
        bindings: {},
        captions: [{ id: 'caption' }],
        voice: { fileObjectId: 'old-voice' },
        bgm: { fileObjectId: 'old-music' },
        detachedAudios: [{ id: 'original-audio' }],
      } as unknown as EffectTemplateMixVariant;
      const props = reactive({
        workflowRunId: 'parent',
        templateId: 'template',
        selectedVariantId: 'film',
        variants: [variant],
      });
      const runs = ref([task('COMPLETED')]);
      const backgroundRun = ref(task(status, 'child', 'new'));
      const state = evaluate<{
        selected: { value: PackagingItem | null };
        selectedVariant: { value: EffectTemplateMixVariant };
      }>(
        panel.slice(panel.indexOf('const orderedRuns ='), panel.indexOf('const boundaryError =')),
        {
          props,
          computed,
          runs,
          backgroundRun,
          currentItem: (item: PackagingItem) => item,
          watch: vi.fn(),
          emit: vi.fn(),
          livePackagingItem,
          packagingPictureOnlyVariant,
        },
        '{ selected, selectedVariant }',
      );
      expect(state.selected.value?.runId).toBe('old');
      expect(state.selectedVariant.value.voice).toEqual(variant.voice);
      expect(state.selectedVariant.value.bgm).toEqual(variant.bgm);
      expect(state.selectedVariant.value.captions).toEqual(variant.captions);
      expect(state.selectedVariant.value.detachedAudios).toEqual(variant.detachedAudios);
      if (status === 'QUEUED' || status === 'RUNNING') {
        props.workflowRunId = 'child';
        expect(state.selected.value).toBeNull();
        expect(state.selectedVariant.value.voice).toBeNull();
        expect(state.selectedVariant.value.bgm).toBeNull();
        expect(variant.voice).toBeDefined(); // Rendering the child did not mutate the baseline.
      }
    },
  );
});
