import { describe, expect, it, vi } from 'vitest';
import { enterLibraryProject } from './enter-library-project';
import drawerSource from '../asset/AssetDrawer.vue?raw';
import pageSource from './ProjectManagementPage.vue?raw';

function setup(current = 'old') {
  let currentId = current;
  const calls: string[] = [];
  return {
    calls,
    context: {
      currentProjectId: () => currentId,
      leaveCurrent: vi.fn(async () => {
        calls.push('save-and-exit');
        currentId = '';
        return true;
      }),
      selectProject: vi.fn((id: string) => {
        calls.push(`select:${id}`);
        currentId = id;
      }),
      flushCurrent: vi.fn(async () => {
        calls.push('save');
        return true;
      }),
      changingWorkflow: false,
    },
  };
}
describe('enter project from global asset library', () => {
  it('saves and exits the previous project before binding the selected one', async () => {
    const { calls, context } = setup();
    expect(await enterLibraryProject('new', context)).toBe(true);
    expect(calls).toEqual(['save-and-exit', 'select:new']);
  });
  it('does not switch or close on a failed save or exit', async () => {
    const { context } = setup();
    context.leaveCurrent.mockResolvedValue(false);
    expect(await enterLibraryProject('new', context)).toBe(false);
    expect(context.selectProject).not.toHaveBeenCalled();
    expect(context.currentProjectId()).toBe('old');
  });
  it('also stops if exit did not clear the old binding or throws', async () => {
    const { context } = setup();
    context.leaveCurrent.mockResolvedValue(true);
    expect(await enterLibraryProject('new', context)).toBe(false);
    context.leaveCurrent.mockRejectedValue(new Error('save failed'));
    await expect(enterLibraryProject('new', context)).rejects.toThrow('save failed');
    expect(context.selectProject).not.toHaveBeenCalled();
  });
  it('reopens the current project and enters from an empty workspace without exiting', async () => {
    for (const current of ['', 'new']) {
      const { context } = setup(current);
      expect(await enterLibraryProject('new', context)).toBe(true);
      expect(context.leaveCurrent).not.toHaveBeenCalled();
    }
  });
  it('saves before changing workflow even when the project is the same', async () => {
    const { context } = setup('new');
    context.changingWorkflow = true;
    expect(await enterLibraryProject('new', context)).toBe(true);
    expect(context.flushCurrent).toHaveBeenCalledOnce();
    expect(context.leaveCurrent).not.toHaveBeenCalled();
    expect(context.currentProjectId()).toBe('new');
  });
  it('keeps the same project and workflow when saving before navigation fails', async () => {
    const { context } = setup('new');
    context.changingWorkflow = true;
    context.flushCurrent.mockResolvedValue(false);
    expect(await enterLibraryProject('new', context)).toBe(false);
    expect(context.leaveCurrent).not.toHaveBeenCalled();
    expect(context.selectProject).not.toHaveBeenCalled();
    expect(context.currentProjectId()).toBe('new');
  });
  it('rejects empty targets and failed bindings', async () => {
    const { context } = setup('');
    expect(await enterLibraryProject('', context)).toBe(false);
    context.selectProject.mockImplementation(() => undefined);
    expect(await enterLibraryProject('missing', context)).toBe(false);
  });
  it('keeps browsing separate from activation and wires busy, error and scope controls', () => {
    expect(drawerSource).toContain('进入项目');
    expect(drawerSource).toContain("emit('enterProject', selectedProject.id, workflow, space)");
    expect(drawerSource).toContain('props.entryBusy || props.suspended');
    expect(drawerSource).toContain('role="alert"');
    expect(pageSource).toContain('@enter-project="enterAssetProject"');
    expect(pageSource).toContain('projectMatchesSpace(target, space)');
    expect(pageSource).not.toContain('projectMatchesWorkflow');
    expect(pageSource).toContain('projectBindings.ids[activeWorkflow.value]');
    expect(pageSource).toContain('projectBindings.reconcile(response.data)');
    expect(pageSource).toContain('leaveCurrent: () => exitProject()');
    const enter =
      pageSource
        .split('const enterAssetProject = async')[1]
        ?.split('const handleProjectAction')[0] ?? '';
    expect(enter.indexOf('await activateWorkflow(workflow)')).toBeLessThan(
      enter.indexOf('await enterLibraryProject'),
    );
    const create = pageSource.split('const submitCreateProject = async')[1] ?? '';
    expect(create.indexOf('await activateWorkflow(createScope.value.workflow!)')).toBeLessThan(
      create.indexOf('await exitProject()'),
    );
    const workflowSwitch = pageSource
      .split('const switchWorkflow = async')[1]
      ?.split('const activeWorkflowMeta')[0];
    expect(workflowSwitch).toContain('await activateWorkflow(workflow)');
    const activate = pageSource
      .split('const activateWorkflow = async')[1]
      ?.split('const switchWorkflow')[0];
    expect(activate).toContain('switchProjectWorkflow(workflow,');
    expect(activate).not.toContain('pauseWorkflowRun');
    expect(workflowSwitch).not.toContain("selectProject('')");
    expect(workflowSwitch).not.toContain('exitProject(');
    expect(workflowSwitch).not.toContain('pauseWorkflowRun');
    const browse = drawerSource
      .split('function enterProject(project: Project): void {')[1]
      ?.split('function backToProjects')[0];
    expect(browse).not.toContain('selectProject');
  });
});
