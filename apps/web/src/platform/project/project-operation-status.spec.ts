import type { Project } from '@ai-marketing/contracts';
import { computed, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import drawerSource from '../asset/AssetDrawer.vue?raw';
import overviewSource from '../asset/components/ProjectWorkspaceOverview.vue?raw';
import { presentProjectOperation } from './project-operation-status';

describe('project operation status', () => {
  it.each(['DRAFT', 'ACTIVE', 'COMPLETED'] as const)(
    'ignores lifecycle %s and marks only the bound project as in operation',
    (status) => {
      const project = { id: 'a', status };
      expect(presentProjectOperation(project, 'a')).toEqual({ label: '进行中', tone: 'active' });
      expect(presentProjectOperation(project, 'b')).toEqual({ label: '未打开', tone: 'idle' });
      expect(presentProjectOperation(project, null)).toEqual({ label: '未打开', tone: 'idle' });
    },
  );

  it('reacts to entering, switching, refreshing and exiting without mutating projects', () => {
    const projects = ref([
      { id: 'a', status: 'ACTIVE' },
      { id: 'b', status: 'ACTIVE' },
    ]);
    const currentId = ref<string | undefined>();
    const labels = computed(() =>
      projects.value.map((project) => presentProjectOperation(project, currentId.value).label),
    );
    expect(labels.value).toEqual(['未打开', '未打开']);
    currentId.value = 'a';
    expect(labels.value).toEqual(['进行中', '未打开']);
    currentId.value = 'b';
    expect(labels.value).toEqual(['未打开', '进行中']);
    projects.value = projects.value.map((project) => ({ ...project }));
    expect(labels.value).toEqual(['未打开', '进行中']);
    currentId.value = undefined;
    expect(labels.value).toEqual(['未打开', '未打开']);
    expect(projects.value.map((project) => project.status)).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it.each([
    ['QUEUED', 'DATABASE', '删除中', 'deleting'],
    ['RUNNING', 'DATABASE', '删除中', 'deleting'],
    ['RUNNING', 'FILES', '清理文件', 'deleting'],
    ['FAILED', 'FILES', '删除失败', 'failed'],
  ] as const)('preserves deletion status %s/%s', (status, phase, label, tone) => {
    const project: Pick<Project, 'id' | 'deletion'> = { id: 'a', deletion: { status, phase } };
    for (const currentId of ['a', 'b', undefined]) {
      expect(presentProjectOperation(project, currentId)).toEqual({ label, tone });
    }
  });

  it('uses the browsed workflow binding for list text and indicator', () => {
    expect(drawerSource).toContain('presentProjectOperation(project, scopedProjectId.value)');
    expect(drawerSource).toContain('props.workflowProjectIds?.[workflow.value]');
    expect(drawerSource).toContain(':class="projectStatus(project).tone"');
    expect(drawerSource).toContain('projectStatus(project).label');
    expect(drawerSource).not.toContain('project.status.toLowerCase()');
    expect(overviewSource).toContain(
      'presentProjectOperation(props.project, currentProject.value?.id)',
    );
  });

  it('does not render the current project deletion control and keeps its column aligned', () => {
    expect(drawerSource).toMatch(
      /<button\s+v-if="!isBoundProject\(project\.id\)"\s+type="button"\s+class="delete-project-button"/,
    );
    expect(drawerSource).toContain('grid-template-columns: minmax(0, 1fr) 66px;');
    expect(drawerSource).toContain('grid-template-columns: minmax(0, 1fr) 33px;');
    expect(drawerSource).toContain("canDelete(project) && emit('deleteProject', project)");
    expect(drawerSource).toContain('Object.values(props.workflowProjectIds).includes(projectId)');
  });
});
