import { describe, expect, it } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import api from './api/effect-template-mix.api.ts?raw';

describe('permanent template deletion interaction', () => {
  const action = page.split('const deleteTemplate =')[1]!.split('const submitTemplateOnEnter')[0]!;
  it('uses the dedicated async deletion API, including templates on another current path', () => {
    expect(action).toContain('deleteEffectTemplateMix(projectId, targetRunId');
    expect(action).not.toContain('此模板已有智能填充或下游分支，不能删除');
    expect(action).not.toContain('saveEffectTemplateMixDraft(');
    expect(action).not.toContain('await openTemplateWorkspace');
    expect(api).toContain("'/delete'");
  });
  it('clearly confirms the irreversible branch/film deletion and keeps shared sources', () => {
    expect(action).toContain('全部成片工程、包装、导出结果及其版本子分支');
    expect(action).toContain('共享素材保留');
    expect(action).toContain("tone: 'danger'");
  });
  it('removes local entries immediately, fences late reads and routes away from a deleted Run', () => {
    expect(action).toContain('draftRace.changed()');
    expect(action).toContain('controller?.abort()');
    expect(action).toContain('templateDirectory.value.entries.filter');
    expect(action).toContain('selectedTemplateWorkflowRunId.value = result.data.workflowRunId');
    expect(action).toContain("emit('workflowRunChange')");
    expect(action).not.toContain('while (');
  });
});
