import { describe, expect, it, vi } from 'vitest';
import { computed, reactive, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectSegmentRenderNodePage.vue?raw';

const harness = (editing = true, selecting = true, allSelected = true) => {
  const context = {
    computed, props: reactive({ projectId: 'project', workflowRunId: 'edit', editing }),
    nodeActive: true, operationController: null as AbortController | null,
    operation: ref<string | null>(null), editTransitioning: ref(false), batchActive: ref(false),
    workspace: ref({ batchId: 'edit-batch', batchRevision: 7, productId: 'product' }),
    selectedTasks: ref([{ id: 'task' }]), selectedTaskIds: ref(new Set(['task'])),
    selectionMode: ref(selecting), allFilteredSelected: ref(allSelected),
    requestActionConfirmation: vi.fn(async () => true), beginEffectWorkflowNodeEdit: vi.fn(),
    deleteEffectSegmentRenderMaterials: vi.fn(async () => ({ data: { batch: { id: 'saved' } } })),
    applyBatch: vi.fn(), emit: vi.fn(), showNotice: vi.fn(),
    safeMessage: (error: Error) => error.message,
  };
  const visibility = `const showDeleteMaterials =${page.split('const showDeleteMaterials =')[1]!
    .split('const exportRangeTasks =')[0]!}`;
  const action = `const deleteSelectedMaterials =${page.split('const deleteSelectedMaterials =')[1]!
    .split('const toggleExportFormat =')[0]!}`;
  const js = transpileModule(visibility + action, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const methods = new Function('context', `with(context) { ${js}; return {execute: deleteSelectedMaterials, visible: showDeleteMaterials}; }`)(context) as {
    execute: () => Promise<void>; visible: { value: boolean };
  };
  return { context, ...methods };
};

describe('render material deletion', () => {
  it.each([
    [false, false, false], [false, false, true], [false, true, false], [false, true, true],
    [true, false, false], [true, false, true], [true, true, false], [true, true, true],
  ])('shows delete only for editing=%s, selecting=%s, allSelected=%s', async (editing, selecting, allSelected) => {
    const { context: c, execute, visible } = harness(editing, selecting, allSelected);
    expect(visible.value).toBe(editing && selecting);
    if (!visible.value) {
      await execute();
      expect(c.requestActionConfirmation).not.toHaveBeenCalled();
      expect(c.deleteEffectSegmentRenderMaterials).not.toHaveBeenCalled();
    }
  });
  it('keeps import in the header and deletion in its original selection-bar position', () => {
    const header = page.split('<div class="segment-heading__actions">')[1]!.split('</header>')[0]!;
    expect(header).not.toContain('deleteSelectedMaterials');
    expect(header).toContain("@click=\"openTransferPanel('import', $event)\"");
    const selectionBar = page.split('class="selection-action-bar"')[1]!.split('class="segment-material-grid"')[0]!;
    expect(selectionBar).toContain('v-if="showDeleteMaterials"');
    expect(selectionBar).toContain(':disabled="!selectedTasks.length || operation !== null || editTransitioning || batchActive"');
    expect(selectionBar).toMatch(/全选筛选结果[\s\S]*deleteSelectedMaterials[\s\S]*导出所选/u);
    expect(selectionBar).toContain('<Trash2 :size="13" />删除');
    expect(page.match(/@click="deleteSelectedMaterials"/gu)).toHaveLength(1);
  });
  it('confirms and deletes only the selected current edit tasks, without automatically entering edit', async () => {
    const { context: c, execute } = harness(true, true, false);
    await execute();
    expect(c.deleteEffectSegmentRenderMaterials).toHaveBeenCalledWith('project', 'edit-batch', {
      taskIds: ['task'], expectedBatchRevision: 7, idempotencyKey: expect.any(String),
    }, expect.any(AbortSignal));
    expect(c.beginEffectWorkflowNodeEdit).not.toHaveBeenCalled();
    expect(c.emit).not.toHaveBeenCalled();
    expect(c.applyBatch).toHaveBeenCalledOnce();
    expect(c.selectedTaskIds.value.size).toBe(0);
    expect(c.selectionMode.value).toBe(false);
    expect(c.operation.value).toBeNull();
  });
  it('does nothing when confirmation is cancelled', async () => {
    const { context: c, execute } = harness();
    c.requestActionConfirmation.mockResolvedValue(false);
    await execute();
    expect(c.deleteEffectSegmentRenderMaterials).not.toHaveBeenCalled();
    expect(c.beginEffectWorkflowNodeEdit).not.toHaveBeenCalled();
    expect(c.selectedTaskIds.value.size).toBe(1);
  });
  it.each(['running', 'transitioning', 'busy', 'empty'] as const)('does nothing while %s', async kind => {
    const { context: c, execute } = harness();
    if (kind === 'running') c.batchActive.value = true;
    if (kind === 'transitioning') c.editTransitioning.value = true;
    if (kind === 'busy') c.operation.value = 'delete';
    if (kind === 'empty') c.selectedTasks.value = [];
    await execute();
    expect(c.requestActionConfirmation).not.toHaveBeenCalled();
    expect(c.deleteEffectSegmentRenderMaterials).not.toHaveBeenCalled();
  });
  it.each(['project', 'run', 'revision', 'batch', 'inactive', 'unselected', 'editing-ended'] as const)('rejects %s changes after confirmation', async kind => {
    const { context: c, execute } = harness();
    c.requestActionConfirmation.mockImplementation(async () => {
      if (kind === 'project') c.props.projectId = 'other';
      if (kind === 'run') c.props.workflowRunId = 'other';
      if (kind === 'revision') c.workspace.value = { ...c.workspace.value, batchRevision: 8 };
      if (kind === 'batch') c.workspace.value = { ...c.workspace.value, batchId: 'other' };
      if (kind === 'inactive') c.nodeActive = false;
      if (kind === 'unselected') c.selectedTasks.value = [];
      if (kind === 'editing-ended') c.props.editing = false;
      return true;
    });
    await execute();
    expect(c.deleteEffectSegmentRenderMaterials).not.toHaveBeenCalled();
    expect(c.beginEffectWorkflowNodeEdit).not.toHaveBeenCalled();
  });
  it('retains the selection and releases the button after a failed delete', async () => {
    const { context: c, execute } = harness();
    c.deleteEffectSegmentRenderMaterials.mockRejectedValue(new Error('删除失败'));
    await execute();
    expect(c.operation.value).toBeNull();
    expect(c.selectedTaskIds.value.size).toBe(1);
    expect(c.applyBatch).not.toHaveBeenCalled();
    expect(c.showNotice).toHaveBeenCalledWith('删除失败', 'error');
  });
});
