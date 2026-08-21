import type {
  AssetWorkflow,
  AssetWorkflowSpace,
  CreateProjectRequest,
  Project,
} from '@ai-marketing/contracts';
import type { InjectionKey, Ref } from 'vue';
import { inject } from 'vue';

export type ProjectBindingState = 'bound' | 'empty' | 'error' | 'loading' | 'unbound';

export type ProjectBindingPresentation = {
  label: string;
  state: ProjectBindingState;
};

const DEFAULT_PROJECT_SPACE: Record<AssetWorkflow, AssetWorkflowSpace> = {
  EFFECT: 'EFFECT',
  CUSTOMIZED: 'CUSTOMIZED_PROJECT',
  FISSION: 'FISSION_CLONE',
};

export const projectCreationScope = (
  workflow: AssetWorkflow,
): Pick<CreateProjectRequest, 'space' | 'workflow'> => ({
  workflow,
  space: DEFAULT_PROJECT_SPACE[workflow],
});

export const resolveBoundProjectId = (
  projects: readonly Project[],
  currentProjectId: string,
  savedProjectId: string,
): string =>
  [currentProjectId, savedProjectId].find((id) => projects.some((project) => project.id === id)) ??
  '';

export const presentProjectBinding = (
  currentProject: Project | null,
  projects: readonly Project[],
  loading: boolean,
  error: string,
): ProjectBindingPresentation => {
  if (currentProject) {
    return {
      label: currentProject.client
        ? `${currentProject.client} · ${currentProject.name}`
        : currentProject.name,
      state: 'bound',
    };
  }
  if (loading) return { label: '正在加载项目…', state: 'loading' };
  if (error) return { label: '项目状态不可用', state: 'error' };
  if (projects.length === 0) return { label: '尚未创建项目', state: 'empty' };
  return { label: '空项目', state: 'unbound' };
};

export type ProjectContext = {
  currentProject: Readonly<Ref<Project | null>>;
  error: Readonly<Ref<string>>;
  loading: Readonly<Ref<boolean>>;
  projects: Readonly<Ref<readonly Project[]>>;
  reload: () => Promise<void>;
  selectProject: (projectId: string) => void;
};

export const projectContextKey: InjectionKey<ProjectContext> = Symbol('project-context');

export const useProjectContext = (): ProjectContext => {
  const context = inject(projectContextKey);
  if (!context) throw new Error('Project context is not available');
  return context;
};
