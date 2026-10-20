// Dev-only visual QA entry; not a production build input.
import { createApp, readonly, ref } from 'vue';
import type { Project } from '@ai-marketing/contracts';
import { projectContextKey } from '../../../platform/project/project-context';
import FissionWorkflowPage from '../shared/FissionWorkflowPage.vue';
import '../../../styles/global.css';
if (import.meta.env.DEV) {
  const project: Project = {
    id: 'MOCK-AVATAR-PROJECT',
    name: '广味食品 · 广式腊味夏季投放',
    description: '独立数字人 Mock 预览',
    status: 'DRAFT',
    createdAt: '2026-10-20T00:00:00Z',
    updatedAt: '2026-10-20T00:00:00Z',
  };
  createApp(FissionWorkflowPage, {
    projectId: 'MOCK-AVATAR-PROJECT',
    projectName: '广味食品 · 广式腊味夏季投放',
    preview: true,
    initialModule: 'avatar',
  })
    .provide(projectContextKey, {
      currentProject: readonly(ref(project)),
      projects: readonly(ref([project])),
      loading: readonly(ref(false)),
      error: readonly(ref('')),
      reload: async () => {},
      selectProject: () => {},
    })
    .mount('#app');
}
