<script setup lang="ts">
import type { AssetWorkflow, CreateProjectRequest, Project } from '@ai-marketing/contracts';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  GitBranch,
  LoaderCircle,
  LogOut,
  Plus,
  Sparkles,
  Target,
  X,
} from '@lucide/vue';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  readonly,
  ref,
} from 'vue';

import AssetDrawer from '../asset/AssetDrawer.vue';
import richiLogoColor from '../../assets/richi-logo-color.png';
import EffectImportNodePage from '../../workflows/effect/source-import/EffectImportNodePage.vue';
import CustomizedImportNodePage from '../../workflows/customized/source-import/CustomizedImportNodePage.vue';
import { createProject, deleteProject, listProjects } from './api/project.api';
import { requestActionConfirmation } from '../../shared/composables/action-confirmation';
import { presentProjectBinding, projectContextKey, projectCreationScope } from './project-context';
import { pauseWorkflowRun } from '../workflow/api/workflow-working.api';
import { loadProjectListWithRetry } from './project-load-retry';
import { enterLibraryProject } from './enter-library-project';
import { switchProjectWorkflow } from './project-workflow-switch';
import { useWorkflowProjectBindings } from './project-workflow-bindings';
import { useProjectDeletionRequests } from './project-deletion-requests';
import { projectMatchesSpace, WORKFLOW_SPACES } from '../asset/asset-v4';
import type { AssetWorkflowSpace } from '@ai-marketing/contracts';

const assetDrawerOpen = ref(false);
const createModalOpen = ref(false);
const createBusy = ref(false);
const createError = ref('');
const createToast = ref('');
const createForm = reactive({ name: '', description: '' });
const createScope = ref(projectCreationScope('EFFECT'));
const createFromLibrary = ref(false);
let createReturnFocus: HTMLElement | null = null;
const projects = ref<Project[]>([]);
const projectsLoading = ref(true);
const projectsError = ref('');
const assetTrigger = ref<HTMLButtonElement | null>(null);
const createTrigger = ref<HTMLButtonElement | null>(null);
const createNameInput = ref<HTMLInputElement | null>(null);
const effectNode = ref<{
  flushPendingEdits: () => Promise<boolean>;
  resumeWorkflowNode: (nodeId: string) => Promise<boolean>;
  workflowRunId: string;
} | null>(null);
const customizedNode = ref<{
  flushPendingEdits: () => Promise<boolean>;
  resumeWorkflowNode: (nodeId: string) => Promise<boolean>;
  workflowRunId: string;
} | null>(null);
const workflowSwitchBusy = ref(false);
const exitBusy = ref(false);
const exitError = ref('');
const projectEntryBusy = ref(false);
const projectEntryError = ref('');
const deletionRequests = useProjectDeletionRequests();
const deletingProjectIds = deletionRequests.pendingIds;
const deletionConfirming = ref(false);
const deletionError = ref('');
const projectListRevision = ref(0);
let projectsController: AbortController | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const WORKFLOW_NAV_ITEMS: ReadonlyArray<{
  description: string;
  label: string;
  title: string;
  value: AssetWorkflow;
}> = [
  {
    value: 'EFFECT',
    label: '效果类',
    title: '效果类 AI 素材批量生成',
    description: '批量导入、提炼、Prompt、渲染、混剪与导出',
  },
  {
    value: 'CUSTOMIZED',
    label: '定制类',
    title: '定制类 AI 视频生产',
    description: 'Brief、分镜、资产绑定、逐镜渲染与交付',
  },
  {
    value: 'FISSION',
    label: '裂变类',
    title: '裂变类 AI 视频生产',
    description: '爆款复刻、数字人口播与局部元素替换',
  },
];
const savedWorkflow = localStorage.getItem('ai-marketing.current-workflow');
const activeWorkflow = ref<AssetWorkflow>(
  WORKFLOW_NAV_ITEMS.some((item) => item.value === savedWorkflow)
    ? (savedWorkflow as AssetWorkflow)
    : 'EFFECT',
);
const projectBindings = useWorkflowProjectBindings(localStorage, activeWorkflow.value);
const currentProjectId = computed(() => projectBindings.ids[activeWorkflow.value]);
const activeNode = computed(() =>
  activeWorkflow.value === 'EFFECT'
    ? effectNode.value
    : activeWorkflow.value === 'CUSTOMIZED'
      ? customizedNode.value
      : null,
);
const activateWorkflow = async (workflow: AssetWorkflow): Promise<boolean> => {
  if (workflow === activeWorkflow.value) return true;
  const switched = await switchProjectWorkflow(workflow, {
    flushPendingEdits: async () => activeNode.value?.flushPendingEdits(),
    activateWorkflow: (next) => {
      activeWorkflow.value = next;
      localStorage.setItem('ai-marketing.current-workflow', next);
    },
  });
  if (switched) await nextTick();
  return switched;
};
const switchWorkflow = async (workflow: AssetWorkflow): Promise<void> => {
  if (
    workflowSwitchBusy.value ||
    createBusy.value ||
    exitBusy.value ||
    projectEntryBusy.value ||
    workflow === activeWorkflow.value
  )
    return;
  workflowSwitchBusy.value = true;
  try {
    const switched = await activateWorkflow(workflow);
    if (!switched) {
      showCreateToast('请先保存当前资料和所选文件，再切换工作流');
      return;
    }
  } catch {
    showCreateToast('切换工作流前保存失败，请重试');
  } finally {
    workflowSwitchBusy.value = false;
  }
};
const activeWorkflowMeta = computed(() =>
  WORKFLOW_NAV_ITEMS.find((item) => item.value === activeWorkflow.value)!,
);

const currentProject = computed(
  () => projects.value.find((project) => project.id === currentProjectId.value) ?? null,
);
const projectBinding = computed(() =>
  presentProjectBinding(
    currentProject.value,
    projects.value,
    projectsLoading.value,
    projectsError.value,
  ),
);

const selectProject = (projectId: string, workflow = activeWorkflow.value): void => {
  if (!projectId) {
    projectBindings.select(workflow, '');
    return;
  }
  if (
    !projects.value.some(
      (project) =>
        project.id === projectId && !project.deletion && !deletionRequests.isPending(project.id),
    )
  )
    return;
  if (projectBindings.ids[workflow] && projectBindings.ids[workflow] !== projectId) {
    showCreateToast('请先退出当前项目，再切换到其他项目');
    return;
  }
  projectBindings.select(workflow, projectId);
};

const loadProjects = async (background = false): Promise<void> => {
  if (background && projectsLoading.value) return;
  projectsController?.abort();
  const controller = new AbortController();
  projectsController = controller;
  if (!background) {
    projectsLoading.value = true;
    projectsError.value = '';
  }
  try {
    const response = await loadProjectListWithRetry(
      (attemptSignal) => listProjects({}, attemptSignal),
      controller.signal,
    );
    if (controller.signal.aborted) return;
    projects.value = response.data;
    projectBindings.reconcile(response.data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (!background)
      projectsError.value = error instanceof Error ? error.message : '项目列表加载失败';
  } finally {
    if (!controller.signal.aborted) projectsLoading.value = false;
  }
};

const refreshProjectsInBackground = (): Promise<void> => loadProjects(true);

provide(projectContextKey, {
  currentProject: readonly(currentProject),
  error: readonly(projectsError),
  loading: readonly(projectsLoading),
  projects: readonly(projects),
  reload: loadProjects,
  selectProject,
});

const closeAssetDrawer = (): void => {
  if (deletionConfirming.value) return;
  assetDrawerOpen.value = false;
  projectEntryError.value = '';
  deletionError.value = '';
  void nextTick(() => assetTrigger.value?.focus());
};

const removeProject = async (project: Project): Promise<void> => {
  if (
    projectBindings.isBound(project.id) ||
    (project.deletion && project.deletion.status !== 'FAILED')
  )
    return;
  if (
    deletionRequests.isPending(project.id) ||
    deletionConfirming.value ||
    projectEntryBusy.value ||
    exitBusy.value ||
    createBusy.value
  )
    return;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  deletionError.value = '';
  deletionConfirming.value = true;
  const confirmed = await requestActionConfirmation({
    title: `删除项目“${project.name}”？`,
    description:
      '确认后将在后台永久删除该项目所有工作流的资料、草稿、历史版本、素材、生成任务和交付文件，无法恢复。提交后可以继续处理其他项目。',
    confirmLabel: '永久删除',
    tone: 'danger',
  });
  deletionConfirming.value = false;
  if (!confirmed) {
    await nextTick();
    if (returnFocus?.isConnected) returnFocus.focus();
    return;
  }
  if (projectBindings.isBound(project.id)) return;
  try {
    const response = await deletionRequests.submit(project.id, () =>
      deleteProject(
        project.id,
        currentProjectId.value ? { currentProjectId: currentProjectId.value } : {},
      ),
    );
    if (!response) return;
    // Invalidate in-flight reads so an old active snapshot cannot reopen a queued project.
    projectsController?.abort();
    projectsLoading.value = false;
    projects.value =
      response.data.status === 'COMPLETED'
        ? projects.value.filter((item) => item.id !== project.id)
        : projects.value.map((item) =>
            item.id === project.id
              ? {
                  ...item,
                  deletion: {
                    status: response.data.status as 'QUEUED' | 'RUNNING' | 'FAILED',
                    phase: 'DATABASE' as const,
                  },
                }
              : item,
          );
    projectListRevision.value += 1;
    showCreateToast(
      response.data.status === 'COMPLETED' ? '项目已删除' : '已提交后台删除，可以继续处理其他项目',
    );
  } catch (error) {
    deletionError.value = `项目“${project.name}”：${error instanceof Error ? error.message : '删除提交失败，请稍后重试'}`;
  }
};

const resumeWorkflowNode = async (nodeId: string): Promise<void> => {
  if (projectEntryBusy.value || !activeNode.value) return;
  const resumed = await activeNode.value.resumeWorkflowNode(nodeId);
  if (!resumed) return;
  assetDrawerOpen.value = false;
};

const createWorkflowLabel = computed(
  () => WORKFLOW_NAV_ITEMS.find((item) => item.value === createScope.value.workflow)?.label ?? '',
);
const openCreateModal = (): void => {
  createScope.value = projectCreationScope(activeWorkflow.value);
  createFromLibrary.value = false;
  prepareCreateModal();
};
const openLibraryCreateModal = (workflow: AssetWorkflow, space: AssetWorkflowSpace): void => {
  if (
    createBusy.value ||
    projectEntryBusy.value ||
    exitBusy.value ||
    !WORKFLOW_SPACES[workflow].includes(space)
  )
    return;
  createScope.value = { workflow, space };
  createFromLibrary.value = true;
  prepareCreateModal();
};
const prepareCreateModal = (): void => {
  createReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  createForm.name = '';
  createForm.description = '';
  createError.value = '';
  createModalOpen.value = true;
  void nextTick(() => createNameInput.value?.focus());
};

const closeCreateModal = (): void => {
  if (createBusy.value) return;
  createModalOpen.value = false;
  void nextTick(() => {
    if (createReturnFocus?.isConnected) createReturnFocus.focus();
    else createTrigger.value?.focus();
  });
};

const keepCreateDialogFocus = (event: KeyboardEvent): void => {
  if (event.key !== 'Tab') return;
  const dialog = event.currentTarget as HTMLElement;
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

const showCreateToast = (message: string): void => {
  createToast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    createToast.value = '';
  }, 3000);
};

const exitProject = async (): Promise<boolean> => {
  const project = currentProject.value;
  if (exitBusy.value) return false;
  if (!project) return true;
  exitBusy.value = true;
  exitError.value = '';
  try {
    if (activeNode.value) {
      const flushed = await activeNode.value.flushPendingEdits();
      if (flushed === false) throw new Error('仍有编辑未能自动保存，请修复后重试退出');
      const workflowRunId = activeNode.value.workflowRunId;
      if (workflowRunId) await pauseWorkflowRun(project.id, workflowRunId);
    }
    selectProject('');
    showCreateToast('草稿已自动保存并退出项目，未创建正式资产');
    return true;
  } catch (error) {
    exitError.value = error instanceof Error ? error.message : '草稿保存失败，请重试';
    showCreateToast(exitError.value);
    return false;
  } finally {
    exitBusy.value = false;
  }
};

const enterAssetProject = async (
  projectId: string,
  workflow: AssetWorkflow,
  space: AssetWorkflowSpace,
): Promise<void> => {
  if (projectEntryBusy.value || exitBusy.value || createBusy.value || workflowSwitchBusy.value)
    return;
  projectEntryBusy.value = true;
  projectEntryError.value = '';
  try {
    if (!projects.value.some((project) => project.id === projectId)) await loadProjects();
    const target = projects.value.find((project) => project.id === projectId);
    if (
      !target ||
      target.deletion ||
      deletionRequests.isPending(projectId) ||
      !WORKFLOW_SPACES[workflow].includes(space) ||
      !projectMatchesSpace(target, space)
    ) {
      projectEntryError.value = '该项目已不可用或不属于所选工作流，请刷新项目列表。';
      return;
    }
    if (!(await activateWorkflow(workflow))) {
      projectEntryError.value = '当前草稿尚未保存，请处理后重试。';
      return;
    }
    const entered = await enterLibraryProject(projectId, {
      currentProjectId: () => currentProjectId.value,
      leaveCurrent: () => exitProject(),
      flushCurrent: async () => (await activeNode.value?.flushPendingEdits()) !== false,
      selectProject: (id) => selectProject(id, workflow),
      changingWorkflow: false,
    });
    if (!entered) {
      projectEntryError.value = exitError.value || '未能进入项目，请稍后重试。';
      return;
    }
    closeAssetDrawer();
  } catch {
    projectEntryError.value = '进入项目失败，请稍后重试。';
  } finally {
    projectEntryBusy.value = false;
  }
};

const handleProjectAction = (): void => {
  if (currentProject.value) void exitProject();
  else openCreateModal();
};

const submitCreateProject = async (): Promise<void> => {
  if (createBusy.value) return;
  const name = createForm.name.trim();
  if (!name) {
    createError.value = '请输入项目名称';
    return;
  }

  createBusy.value = true;
  createError.value = '';
  const input: CreateProjectRequest = {
    name,
    ...createScope.value,
    ...(createForm.description.trim() ? { description: createForm.description.trim() } : {}),
  };

  try {
    // Save the visible workflow, then replace only the target workflow's project binding.
    if (!(await activateWorkflow(createScope.value.workflow!))) {
      createError.value = '当前草稿尚未保存，请处理后重试';
      return;
    }
    if (currentProject.value && !(await exitProject())) {
      createError.value = exitError.value || '当前项目尚未保存，请处理后重试';
      return;
    }
    const response = await createProject(input);
    projects.value = [
      response.data,
      ...projects.value.filter((project) => project.id !== response.data.id),
    ];
    selectProject(response.data.id);
    await loadProjects();
    createModalOpen.value = false;
    if (createFromLibrary.value) closeAssetDrawer();
    void nextTick(() => createTrigger.value?.focus());
    showCreateToast(`项目“${response.data.name}”创建成功`);
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '创建项目失败，请稍后重试';
  } finally {
    createBusy.value = false;
  }
};

onMounted(() => void loadProjects());
onBeforeUnmount(() => {
  projectsController?.abort();
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="system-page">
    <header class="system-header">
      <div class="system-brand">
        <span class="brand-mark"><img :src="richiLogoColor" alt="瑞池传媒" /></span>
        <span
          ><strong>AI 营销素材智能生成系统</strong><small>RICH MEDIA · AI MARKETING</small></span
        >
      </div>
      <nav aria-label="业务模块">
        <button
          v-for="item in WORKFLOW_NAV_ITEMS"
          :key="item.value"
          :class="{ active: activeWorkflow === item.value }"
          type="button"
          :aria-pressed="activeWorkflow === item.value"
          :disabled="projectEntryBusy || exitBusy || workflowSwitchBusy || createBusy"
          @click="switchWorkflow(item.value)"
        >
          {{ item.label }}
        </button>
      </nav>
      <div class="system-actions">
        <button
          ref="createTrigger"
          :class="currentProject ? 'exit-entry' : 'create-entry'"
          type="button"
          :disabled="exitBusy || projectEntryBusy || workflowSwitchBusy || createBusy"
          @click="handleProjectAction"
        >
          <LogOut v-if="currentProject" :size="15" />
          <Plus v-else :size="15" />
          {{
            currentProject
              ? exitBusy || workflowSwitchBusy
                ? '正在保存草稿…'
                : '退出项目'
              : '新建项目'
          }}
        </button>
        <button
          ref="assetTrigger"
          class="asset-entry"
          type="button"
          @click="assetDrawerOpen = true"
        >
          <Boxes :size="15" />项目与资产
        </button>
      </div>
    </header>
    <div class="system-context">
      <span class="context-icon">
        <Target v-if="activeWorkflow === 'EFFECT'" :size="17" />
        <Sparkles v-else-if="activeWorkflow === 'CUSTOMIZED'" :size="17" />
        <GitBranch v-else :size="17" />
      </span>
      <strong>{{ activeWorkflowMeta.title }}</strong>
      <span class="context-project" :class="`is-${projectBinding.state}`">
        <i aria-hidden="true" />{{ projectBinding.label }}
      </span>
    </div>
    <main :aria-label="`${activeWorkflowMeta.label}工作流`">
      <section v-if="!currentProject" class="workflow-state" role="status">
        <span class="workflow-state-icon">
          <Target v-if="activeWorkflow === 'EFFECT'" :size="30" />
          <Sparkles v-else-if="activeWorkflow === 'CUSTOMIZED'" :size="30" />
          <GitBranch v-else :size="30" />
        </span>
        <h2>{{ projectBinding.label }}</h2>
        <p>{{ activeWorkflowMeta.description }}</p>
        <small v-if="projectBinding.state === 'error'">{{ projectsError }}</small>
        <small v-else>工作流可以自由切换；创建或绑定项目后再加载项目数据。</small>
        <button v-if="projectBinding.state === 'empty'" type="button" @click="openCreateModal">
          <Plus :size="15" />新建项目
        </button>
        <button
          v-else-if="projectBinding.state === 'unbound'"
          type="button"
          @click="assetDrawerOpen = true"
        >
          <Boxes :size="15" />前往项目资产库
        </button>
        <button v-else-if="projectBinding.state === 'error'" type="button" @click="loadProjects()">
          重新加载项目
        </button>
      </section>
      <EffectImportNodePage v-else-if="activeWorkflow === 'EFFECT'" ref="effectNode" />
      <CustomizedImportNodePage
        v-else-if="activeWorkflow === 'CUSTOMIZED'"
        :key="currentProject.id"
        ref="customizedNode"
      />
      <section v-else class="workflow-state workflow-state-ready" role="status">
        <span class="workflow-state-icon">
          <GitBranch :size="30" />
        </span>
        <h2>已切换到{{ activeWorkflowMeta.label }}工作流</h2>
        <p>当前项目：{{ currentProject.name }}</p>
        <small>{{ activeWorkflowMeta.description }}。具体业务页面将在对应工作流模块中接入。</small>
      </section>
    </main>
    <AssetDrawer
      :open="assetDrawerOpen"
      :initial-workflow="activeWorkflow"
      :entry-busy="projectEntryBusy"
      :entry-error="projectEntryError"
      :suspended="createModalOpen || deletionConfirming"
      :deleting-project-ids="deletingProjectIds"
      :deletion-error="deletionError"
      :refresh-token="projectListRevision"
      :workflow-project-ids="projectBindings.ids"
      @close="closeAssetDrawer"
      @resume-node="resumeWorkflowNode"
      @enter-project="enterAssetProject"
      @create-project="openLibraryCreateModal"
      @delete-project="removeProject"
      @deletions-changed="refreshProjectsInBackground"
    />

    <Transition name="modal-fade">
      <div v-if="createModalOpen" class="create-overlay" @mousedown.self="closeCreateModal">
        <section
          class="create-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-project-title"
          @keydown.esc.stop="closeCreateModal"
          @keydown="keepCreateDialogFocus"
        >
          <header class="create-modal-head">
            <div>
              <p>通用基础能力</p>
              <h2 id="create-project-title">新建项目</h2>
              <span>创建后将自动设为当前项目，并归入{{ createWorkflowLabel }}项目资产库。</span>
            </div>
            <button
              class="modal-close"
              type="button"
              aria-label="关闭新建项目弹窗"
              :disabled="createBusy"
              @click="closeCreateModal"
            >
              <X :size="17" />
            </button>
          </header>

          <form class="create-form" @submit.prevent="submitCreateProject">
            <label>
              <span>项目名称 <b>*</b></span>
              <!-- prettier-ignore -->
              <input
                ref="createNameInput"
                v-model="createForm.name"
                maxlength="120"
                placeholder="例如：广味食品 · 夏季投放"
                :disabled="createBusy"
                @input="createError = ''"
              >
            </label>

            <label>
              <span>项目说明</span>
              <textarea
                v-model="createForm.description"
                maxlength="500"
                rows="4"
                placeholder="可选，简要说明项目目标与素材用途"
                :disabled="createBusy"
              />
              <small>{{ createForm.description.length }} / 500</small>
            </label>

            <div v-if="createError" class="create-error" role="alert">
              <AlertTriangle :size="16" />{{ createError }}
            </div>

            <footer class="create-modal-footer">
              <button type="button" :disabled="createBusy" @click="closeCreateModal">取消</button>
              <button class="primary" type="submit" :disabled="createBusy">
                <LoaderCircle v-if="createBusy" class="spinner" :size="16" />
                <Plus v-else :size="16" />
                {{ createBusy ? '创建中…' : '确认创建' }}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </Transition>

    <Transition name="toast-fade">
      <div v-if="createToast" class="create-toast" role="status">
        <CheckCircle2 :size="17" />{{ createToast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.system-page {
  --blue: #2766ed;
  min-height: 100vh;
  color: #17233a;
  background:
    radial-gradient(circle at 5% 30%, #ffececab, transparent 24%),
    linear-gradient(135deg, #fbfdff, #f3f7ff);
}
.system-header {
  display: flex;
  height: 68px;
  padding: 0 34px;
  align-items: center;
  gap: 48px;
  background: #fffffff7;
  border-bottom: 1px solid #dce5f2;
  box-shadow: 0 5px 22px #1d4ed80a;
}
.system-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  white-space: nowrap;
}
.system-brand > span:last-child {
  display: flex;
  flex-direction: column;
}
.system-brand strong {
  font-size: 17px;
}
.system-brand small {
  margin-top: 2px;
  color: #8b97a9;
  font-size: 7px;
  font-weight: 800;
  letter-spacing: 0.18em;
}
.brand-mark {
  display: block;
  width: 40px;
  height: 40px;
  overflow: hidden;
  flex: 0 0 auto;
  background: #fff;
  border-radius: 11px;
  box-shadow: 0 8px 18px #d9ab3638;
}
.brand-mark img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
}
nav {
  display: flex;
  height: 100%;
  align-items: stretch;
  gap: 35px;
}
nav button {
  position: relative;
  display: flex;
  padding: 0;
  align-items: center;
  color: #66758c;
  background: transparent;
  border: 0;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
}
nav .active {
  color: var(--blue);
}
nav .active:after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 3px;
  border-radius: 3px 3px 0 0;
  background: var(--blue);
  content: '';
}
.system-actions {
  display: flex;
  margin-left: auto;
  align-items: center;
  gap: 8px;
}
.create-entry,
.exit-entry,
.asset-entry {
  display: inline-flex;
  min-height: 36px;
  padding: 0 13px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 800;
  transition: 0.18s ease;
}
.create-entry {
  color: #fff;
  background: var(--blue);
  border: 1px solid var(--blue);
  box-shadow: 0 6px 15px #2563eb2c;
}
.create-entry:hover {
  background: #1d4ed8;
  transform: translateY(-1px);
}
.exit-entry {
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
}
.exit-entry:hover {
  color: #92400e;
  background: #fef3c7;
  border-color: #f6c84f;
}
.asset-entry {
  color: #475569;
  background: #fff;
  border: 1px solid #dbe4f6;
}
.asset-entry:hover {
  color: var(--blue);
  background: #eef3ff;
  border-color: #93b4ff;
}
.system-context {
  display: flex;
  height: 64px;
  padding: 0 34px;
  align-items: center;
  gap: 12px;
  background: #fafcffed;
  border-bottom: 1px solid #dce5f2;
}
.context-icon {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  color: var(--blue);
  background: #edf3ff;
  border: 1px solid #ccdcfb;
  border-radius: 11px;
}
.system-context strong {
  font-size: 14px;
}
.context-project {
  display: inline-flex;
  min-height: 34px;
  margin-left: 8px;
  padding: 0 13px;
  align-items: center;
  gap: 7px;
  color: #416089;
  background: #edf3ff;
  border: 1px solid #d3e1fa;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 800;
}
.context-project i {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  background: #2f6fed;
  border-radius: 50%;
  box-shadow: 0 0 0 3px #dbe8ff;
}
.context-project.is-empty,
.context-project.is-unbound {
  color: #68768a;
  background: #fff;
  border-style: dashed;
}
.context-project.is-empty i,
.context-project.is-unbound i {
  background: #95a2b5;
  box-shadow: 0 0 0 3px #edf1f6;
}
.context-project.is-error {
  color: #a54343;
  background: #fff5f5;
  border-color: #f2caca;
}
.context-project.is-error i {
  background: #d45b5b;
  box-shadow: 0 0 0 3px #fde2e2;
}
.context-project.is-loading i {
  animation: context-pulse 1s ease-in-out infinite alternate;
}
@keyframes context-pulse {
  to {
    opacity: 0.35;
  }
}
main {
  min-height: calc(100vh - 132px);
}
.workflow-state {
  display: flex;
  min-height: calc(100vh - 132px);
  padding: 32px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #273a58;
  text-align: center;
}
.workflow-state-icon {
  display: grid;
  width: 62px;
  height: 62px;
  margin-bottom: 15px;
  place-items: center;
  color: var(--blue);
  background: #edf3ff;
  border: 1px solid #ccdcfb;
  border-radius: 18px;
}
.workflow-state h2 {
  margin: 0;
  font-size: 21px;
}
.workflow-state p {
  margin: 9px 0 0;
  color: #66758c;
  font-size: 13px;
}
.workflow-state small {
  max-width: 540px;
  margin-top: 6px;
  color: #8a97aa;
  font-size: 11px;
  line-height: 1.7;
}
.workflow-state > button {
  display: inline-flex;
  min-height: 36px;
  margin-top: 18px;
  padding: 0 14px;
  align-items: center;
  gap: 6px;
  color: #fff;
  background: var(--blue);
  border: 1px solid var(--blue);
  border-radius: 10px;
  font-size: 12px;
  font-weight: 800;
}
.workflow-state-ready {
  background: linear-gradient(135deg, #fffaf8, #f4f8ff);
}
.create-overlay {
  position: fixed;
  z-index: 220;
  inset: 0;
  display: grid;
  padding: 20px;
  place-items: center;
  background: #0f172a66;
  backdrop-filter: blur(3px);
}
.create-modal {
  width: min(560px, 100%);
  overflow: hidden;
  background: #fff;
  border-radius: 24px;
  box-shadow: 0 28px 80px #0f172a42;
}
.create-modal-head {
  display: flex;
  padding: 22px 24px 18px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  background: #fffffff7;
  border-bottom: 1px solid #dbe4f6;
}
.create-modal-head p {
  margin: 0 0 5px;
  color: var(--blue);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1px;
}
.create-modal-head h2 {
  margin: 0;
  font-size: 22px;
}
.create-modal-head span {
  display: block;
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.7;
}
.modal-close {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  padding: 0;
  place-items: center;
  color: #64748b;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 50%;
}
.modal-close:hover:not(:disabled) {
  color: var(--blue);
  background: #eef3ff;
}
.create-form {
  display: grid;
  padding: 20px 24px 24px;
  gap: 18px;
}
.create-form label {
  position: relative;
  display: grid;
  gap: 7px;
}
.create-form label > span {
  color: #475569;
  font-size: 11px;
  font-weight: 800;
}
.create-form b {
  color: #dc2626;
}
.create-form input,
.create-form textarea {
  width: 100%;
  padding: 0 12px;
  color: #334155;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 12px;
  outline: none;
  resize: vertical;
}
.create-form input {
  height: 39px;
}
.create-form textarea {
  min-height: 100px;
  padding-top: 11px;
  padding-bottom: 24px;
}
.create-form input:focus,
.create-form textarea:focus {
  border-color: #93b4ff;
  box-shadow: 0 0 0 3px #2563eb10;
}
.create-form input:disabled,
.create-form textarea:disabled {
  background: #f8fafc;
}
.create-form small {
  position: absolute;
  right: 11px;
  bottom: 8px;
  color: #94a3b8;
  font-size: 10px;
}
.create-error {
  display: flex;
  padding: 11px 12px;
  align-items: center;
  gap: 8px;
  color: #b42318;
  background: #fff3f2;
  border: 1px solid #fecaca;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 700;
}
.create-modal-footer {
  display: flex;
  margin: 2px -24px -24px;
  padding: 14px 24px;
  justify-content: flex-end;
  gap: 9px;
  background: #fffffff5;
  border-top: 1px solid #dbe4f6;
}
.create-modal-footer button {
  display: inline-flex;
  min-height: 36px;
  padding: 0 13px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #475569;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 800;
}
.create-modal-footer button.primary {
  min-width: 112px;
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
  box-shadow: 0 6px 15px #2563eb2c;
}
.create-modal-footer button.primary:hover:not(:disabled) {
  background: #1d4ed8;
}
.create-toast {
  position: fixed;
  z-index: 200;
  top: 82px;
  left: 50%;
  display: flex;
  max-width: min(520px, 90vw);
  padding: 11px 17px;
  align-items: center;
  gap: 8px;
  transform: translateX(-50%);
  color: #fff;
  background: #172033eb;
  border-radius: 999px;
  box-shadow: 0 12px 32px #0f172a36;
  font-size: 12px;
  font-weight: 700;
}
.spinner {
  animation: spinner-rotate 0.8s linear infinite;
}
.modal-fade-enter-active,
.modal-fade-leave-active,
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.2s ease;
}
.modal-fade-enter-from,
.modal-fade-leave-to,
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
}
@keyframes spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 760px) {
  .system-header {
    height: 62px;
    padding: 0 15px;
    gap: 14px;
  }
  .system-brand strong,
  .system-brand small {
    display: none;
  }
  nav {
    gap: 12px;
  }
  nav button {
    font-size: 11px;
  }
  .system-actions {
    gap: 5px;
  }
  .create-entry,
  .exit-entry,
  .asset-entry {
    width: 36px;
    padding: 0;
    overflow: hidden;
    font-size: 0;
  }
  .system-context {
    height: 58px;
    padding: 0 15px;
  }
  .context-project {
    max-width: 48vw;
    min-height: 32px;
    margin-left: 0;
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  main {
    min-height: calc(100vh - 120px);
  }
}
</style>
