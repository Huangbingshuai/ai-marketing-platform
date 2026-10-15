import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';

function harness() {
  const activeTemplateId = ref('other');
  const aiRuns = ref([{ templateId: 'filling', status: 'RUNNING', operation: 'FILL' }]);
  const activeEntry = ref<{ aiFillLocked?: boolean }>({});
  const context = {
    computed,
    activeTemplateId,
    aiRuns,
    pendingFillRun: ref<unknown>(null),
    activeEntry,
    runSwitching: ref(false),
    fillStartPending: ref(false),
    packagingSourceAutoLocked: ref(false),
  };
  const source = `const activeAiRun =${page.split('const activeAiRun =')[1]!.split('const displayedBackgroundAi =')[0]!}
    const workspaceTaskLocked =${page.split('const workspaceTaskLocked =')[1]!.split('const sourceUpdateLockedVariantIds =')[0]!}`;
  const script = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const locks = new Function(
    ...Object.keys(context),
    `${script}\nreturn { activeAiRun, workspaceTaskLocked };`,
  )(...Object.values(context));
  return { ...context, ...locks };
}

describe('smart-fill task locks belong to the selected template', () => {
  it.each(['QUEUED', 'RUNNING'])(
    'locks only the owner of a %s fill across repeated selections',
    (status) => {
      const c = harness();
      c.aiRuns.value[0]!.status = status;
      expect(c.workspaceTaskLocked.value).toBe(false);
      for (let i = 0; i < 2; i += 1) {
        c.activeTemplateId.value = 'filling';
        expect(c.workspaceTaskLocked.value).toBe(true);
        c.activeTemplateId.value = 'other';
        expect(c.workspaceTaskLocked.value).toBe(false);
      }
      expect(c.aiRuns.value[0]!.status).toBe(status);
    },
  );

  it('retains server-owned lock and packaging guards independently of the task projection', () => {
    const c = harness();
    c.activeEntry.value.aiFillLocked = true;
    expect(c.workspaceTaskLocked.value).toBe(true);
    c.activeEntry.value = {};
    c.packagingSourceAutoLocked.value = true;
    expect(c.workspaceTaskLocked.value).toBe(true);
  });

  it('releases finished fills but keeps navigation and request-start race guards', () => {
    const c = harness();
    c.activeTemplateId.value = 'filling';
    c.aiRuns.value[0]!.status = 'COMPLETED';
    expect(c.workspaceTaskLocked.value).toBe(false);
    c.fillStartPending.value = true;
    expect(c.workspaceTaskLocked.value).toBe(true);
    c.fillStartPending.value = false;
    c.runSwitching.value = true;
    expect(c.workspaceTaskLocked.value).toBe(true);
  });

  it('keeps a completed receipt locked only while its films are still being installed', () => {
    const c = harness();
    c.activeTemplateId.value = 'filling';
    c.aiRuns.value[0]!.status = 'COMPLETED';
    c.pendingFillRun.value = c.aiRuns.value[0];
    expect(c.workspaceTaskLocked.value).toBe(true);
    c.pendingFillRun.value = null;
    expect(c.workspaceTaskLocked.value).toBe(false);
  });
});
