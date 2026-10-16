import { describe, expect, it } from 'vitest';
import rawPage from './EffectTemplateMixNodePage.vue?raw';
import rawApi from './api/effect-template-mix.api.ts?raw';
import rawParent from '../source-import/EffectImportNodePage.vue?raw';
import rawOutput from '../final-output/EffectFinalOutputNodePage.vue?raw';

const page = rawPage.replace(/\r\n/g, '\n');
const api = rawApi.replace(/\r\n/g, '\n');
const parent = rawParent.replace(/\r\n/g, '\n');
const output = rawOutput.replace(/\r\n/g, '\n');

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
    expect(action).toContain('withoutDeletedMixCatalog(templateDirectory.value, deleted)');
    expect(action).toContain('selectedTemplateWorkflowRunId.value = destination.workflowRunId');
    expect(action).toContain("emit('templateDeleted', receipt)");
    expect(action).not.toContain("emit('workflowRunChange')");
    expect(action).not.toContain('await load()');
    const accepted = action.split('const receipt: EffectTemplateDeleted =')[1]!;
    expect(accepted).not.toContain('await loadEffectTemplateMixWorkspace');
    expect(action).toContain(
      'const latest = await loadEffectTemplateMixWorkspace(projectId, targetRunId)',
    );
    expect(action).not.toContain('while (');
  });
  it('does not lock other template selection or show a parent branch-publication curtain', () => {
    const handler = parent
      .split('const handleTemplateDeleted =')[1]!
      .split('const flushGlobalConfig')[0]!;
    expect(handler).toContain('showCurtain: false');
    expect(handler).toContain('if (currentRemoved)');
    expect(page).toContain(':disabled="mutating || deletingTemplateId === entry.id"');
    expect(page).toContain('正在提交删除…');
    expect(action).toContain('if (wasSelected)');
    expect(action).toContain('templateNavigationPending.value = false');
  });
  it('removes output previews/settings and prevents late output reads from reviving the template', () => {
    expect(output).toContain('readTemplateDeleted(value)');
    expect(output).toContain('!deletedTemplateIds().has(entry.templateId)');
    expect(output).toContain('withoutDeletedMixCatalog(directory, deletedTemplateIds())');
    expect(output).toContain('settingsByTemplate.value.delete(receipt.templateId)');
    expect(output).toContain('if (wasSelected) {\n      closePreviewDialog(false)');
    expect(output).toContain('其他成片可继续操作');
  });
  it('awaits the accepted deletion handoff before saving navigation into the surviving Run', () => {
    const flush = parent.split('async function flushPendingEdits()')[1]!.split('const ')[0]!;
    expect(flush.indexOf('await templateDeletionRefresh')).toBeGreaterThan(-1);
    expect(parent).toContain('templateDeletionRefresh = refresh');
    const save = parent
      .split('const saveWorkflowNodeState =')[1]!
      .split('const isCurrentContext')[0]!;
    expect(save.split('workspace.value?.workflowRunId !== workflowRunId')).toHaveLength(4);
    expect(
      save.indexOf(
        'workspace.value?.workflowRunId !== workflowRunId',
        save.indexOf('await putWorkflowNodeState'),
      ),
    ).toBeLessThan(save.indexOf('nodeStateRevision.value = response'));
  });
});
