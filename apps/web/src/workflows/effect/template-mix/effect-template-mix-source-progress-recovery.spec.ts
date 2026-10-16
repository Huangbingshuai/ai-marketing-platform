import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';

function recovery(frozen?: string[]) {
  const items = Array.from({ length: 9 }, (_, index) => ({
    id: `i${index}`,
    variantId: `v${index}`,
    status: index < 6 ? 'COMPLETED' : 'QUEUED',
    progress: index < 6 ? 100 : 0,
  }));
  const run = {
    id: 'task',
    workflowRunId: 'run',
    templateId: 'template',
    status: 'RUNNING',
    items,
    ...(frozen ? { sourceOperationVariantIds: frozen } : {}),
  };
  const context = {
    computed,
    sourceUpdateRun: ref<unknown>(null),
    sourceUpdateItemIds: ref<string[]>([]),
    sourceUpdateGeneration: 1,
    stopSourceUpdatePolling: vi.fn(),
    props: { projectId: 'project', workflowRunId: 'run' },
    activeTemplateId: ref('template'),
    loadMixFinalOutputRuns: vi.fn(async () => ({ data: [run] })),
    pollSourceUpdate: vi.fn(),
    continueFrozenAppend: vi.fn(),
  };
  const source =
    page.slice(
      page.indexOf('async function resumeSourceUpdate()'),
      page.indexOf('async function continueFrozenAppend('),
    ) +
    '\n' +
    page.slice(
      page.indexOf('const sourceUpdateProgress ='),
      page.indexOf('const localUpdateBusy ='),
    );
  const script = transpileModule(source, {}).outputText;
  const functions = new Function(
    ...Object.keys(context),
    `${script}\nreturn { resumeSourceUpdate, sourceUpdateProgress };`,
  )(...Object.values(context));
  return { ...context, ...functions };
}

describe('source-update refresh uses the frozen full target set', () => {
  it('restores 6/8 completed rather than resetting to the two remaining items', async () => {
    const h = recovery(Array.from({ length: 8 }, (_, i) => `v${i}`));
    await h.resumeSourceUpdate();
    expect(h.sourceUpdateItemIds.value).toEqual(Array.from({ length: 8 }, (_, i) => `i${i}`));
    expect(h.sourceUpdateProgress.value).toBe(75);
    expect(h.pollSourceUpdate).toHaveBeenCalledOnce();
  });
  it('does not include an unrelated queued film or invent targets for a zero-source append', async () => {
    const h = recovery([]);
    await h.resumeSourceUpdate();
    expect(h.sourceUpdateItemIds.value).toEqual([]);
    expect(h.sourceUpdateProgress.value).toBe(0);
  });
  it('keeps the existing pending-only recovery for old tasks without a frozen target list', async () => {
    const h = recovery();
    await h.resumeSourceUpdate();
    expect(h.sourceUpdateItemIds.value).toEqual(['i6', 'i7', 'i8']);
  });
});
