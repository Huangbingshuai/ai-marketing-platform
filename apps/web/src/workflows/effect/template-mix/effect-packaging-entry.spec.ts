import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { transpileModule } from 'typescript';
import component from './EffectTemplateMixPackaging.vue?raw';
import page from './EffectTemplateMixNodePage.vue?raw';

function actionHarness() {
  const context = {
    busy: ref(false),
    active: ref(false),
    backgroundActive: ref(false),
    loading: ref(true),
    completeCount: ref(42),
    requestError: ref(''),
    create: vi.fn(async () => {}),
    selectedStage: ref(null),
    visible: ref(false),
    nextTick: vi.fn(async () => {}),
    dialog: ref(null),
    refresh: vi.fn(),
  };
  const source = `async function open${component.split('async function open')[1]!.split('function close()')[0]!}`;
  const open = new Function(
    ...Object.keys(context),
    `${transpileModule(source, {}).outputText}\nreturn open;`,
  )(...Object.values(context)) as (mode: 'ACTION' | 'WORKFLOW') => Promise<void>;
  return { ...context, open };
}

describe('packaging workbench entry', () => {
  it.each([
    'localUpdateStarting',
    'sourceUpdateBusy',
    'sourceUpdateHandoff',
    'pendingAppendContinuation',
    'activeAppendRun',
    'activeAppendPackaging',
  ])('blocks packaging throughout the %s local-update phase and unlocks afterward', (phase) => {
    const state = {
      localUpdateStarting: ref(false),
      sourceUpdateBusy: ref(false),
      sourceUpdateHandoff: ref(false),
      pendingAppendContinuation: ref(false),
      activeAppendRun: ref(false),
      activeAppendPackaging: ref(false),
    };
    const context = {
      ...state,
      computed,
      runSwitching: ref(false),
      activeEntry: ref({}),
      pendingAddedCount: ref(0),
      templatePendingUpdateCount: () => 0,
    };
    const busySource = `const localUpdateBusy = computed(${page.split('const localUpdateBusy = computed(')[1]!.split('const localUpdateProgress')[0]!}`;
    const reasonSource = `const packagingActionBlockReason = computed(${page.split('const packagingActionBlockReason = computed(')[1]!.split('const committedVersions')[0]!}`;
    const reason = new Function(
      ...Object.keys(context),
      `${transpileModule(busySource + reasonSource, {}).outputText}\nreturn packagingActionBlockReason;`,
    )(...Object.values(context));
    expect(reason.value).toBeNull();
    state[phase as keyof typeof state].value = true;
    expect(reason.value).toContain('正在局部更新');
    state[phase as keyof typeof state].value = false;
    expect(reason.value).toBeNull();
  });
  it('disables the batch button and guards submission while preserving workflow details', () => {
    const button = page
      .split('class="project-actions"')[1]!
      .split('@click="openPackaging(\'ACTION\')"')[0]!;
    expect(button.split(':disabled="')[1]!.split('"')[0]).toContain('localUpdateBusy');
    const panelOpen = vi.fn();
    const context = {
      packagingActionBlockReason: ref('当前模板正在局部更新'),
      packagingPanel: ref({ open: panelOpen }),
      showNotice: vi.fn(),
    };
    const source = `const openPackaging = ${page.split('const openPackaging = ')[1]!.split('const handlePackagingSubmissionPending')[0]!}`;
    const open = new Function(
      ...Object.keys(context),
      `${transpileModule(source, {}).outputText}\nreturn openPackaging;`,
    )(...Object.values(context));
    open('ACTION');
    expect(panelOpen).not.toHaveBeenCalled();
    open('WORKFLOW');
    expect(panelOpen).toHaveBeenCalledWith('WORKFLOW');
    expect(page.split('const preparePackaging = ')[1]!.split('const startAiFill')[0]).toContain(
      'if (packagingActionBlockReason.value)',
    );
    expect(page.split('<EffectSinglePackagingControl')[1]!.split('/>')[0]).toContain(
      'Boolean(packagingActionBlockReason)',
    );
  });
  it('accepts a click while the initial history request is still pending', async () => {
    const h = actionHarness();
    await h.open('ACTION');
    expect(h.loading.value).toBe(true);
    expect(h.create).toHaveBeenCalledOnce();
    const button = page
      .split('class="project-actions"')[1]!
      .split('@click="openPackaging(\'ACTION\')"')[0]!;
    expect(button).not.toContain('packagingPanel?.loading');
  });
  it.each(['busy', 'active', 'backgroundActive'] as const)(
    'retains the real %s task guard',
    async (key) => {
      const h = actionHarness();
      h[key].value = true;
      await h.open('ACTION');
      expect(h.create).not.toHaveBeenCalled();
    },
  );
  it('does not submit twice when the first click is preparing the task', async () => {
    const h = actionHarness();
    let settle!: () => void;
    h.create.mockImplementation(async () => {
      h.busy.value = true;
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
    });
    const first = h.open('ACTION');
    await h.open('ACTION');
    expect(h.create).toHaveBeenCalledOnce();
    settle();
    await first;
  });
  it('does not turn an empty film into a packageable project', async () => {
    const h = actionHarness();
    h.completeCount.value = 0;
    await h.open('ACTION');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.requestError.value).toContain('空成片不参与包装');
  });
});
