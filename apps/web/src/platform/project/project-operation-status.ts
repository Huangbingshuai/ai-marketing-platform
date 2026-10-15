import type { Project } from '@ai-marketing/contracts';

/** UI operation status follows the current binding, not the persisted lifecycle. */
export function presentProjectOperation(
  project: Pick<Project, 'id' | 'deletion'>,
  currentProjectId: string | null | undefined,
): { label: string; tone: 'active' | 'idle' | 'deleting' | 'failed' } {
  if (project.deletion) {
    if (project.deletion.status === 'FAILED') return { label: '删除失败', tone: 'failed' };
    return {
      label: project.deletion.phase === 'FILES' ? '清理文件' : '删除中',
      tone: 'deleting',
    };
  }
  return project.id === currentProjectId
    ? { label: '进行中', tone: 'active' }
    : { label: '未打开', tone: 'idle' };
}
