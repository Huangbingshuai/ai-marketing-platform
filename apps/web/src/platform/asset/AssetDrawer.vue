<script setup lang="ts">
import type { AssetWorkflow, AssetWorkflowSpace, Project } from '@ai-marketing/contracts';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  LogIn,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { isAbortError } from '../../api/http-client';
import { createProject, listProjects } from '../project/api/project.api';
import { useProjectContext } from '../project/project-context';
import { SPACE_LABELS, WORKFLOW_META, WORKFLOW_SPACES, projectMatchesSpace } from './asset-v4';
import { formatAssetTime } from './project-asset-browser';
import ProjectAssetBrowser from './components/ProjectAssetBrowser.vue';

const props = withDefaults(
  defineProps<{
    initialWorkflow?: AssetWorkflow;
    open: boolean;
    entryBusy?: boolean;
    entryError?: string;
  }>(),
  {
    initialWorkflow: 'EFFECT',
    entryBusy: false,
    entryError: '',
  },
);
const emit = defineEmits<{
  close: [];
  resumeNode: [nodeId: string];
  enterProject: [projectId: string, workflow: AssetWorkflow, space: AssetWorkflowSpace];
}>();
const { currentProject, reload, selectProject } = useProjectContext();
const workflow = ref<AssetWorkflow>(props.initialWorkflow);
const space = ref<AssetWorkflowSpace>(WORKFLOW_SPACES[props.initialWorkflow][0]!);
const projects = ref<Project[]>([]);
const selectedProject = ref<Project | null>(null);
const keyword = ref('');
const loading = ref(false);
const error = ref('');
const creating = ref(false);
const drawer = ref<HTMLElement | null>(null);
let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let trigger: HTMLElement | null = null;
const matchingProjects = computed(() =>
  projects.value.filter((project) => projectMatchesSpace(project, space.value)),
);
// The voice library is a shared-library space, not a workflow project.
// Keep actual avatar workflow projects instead of presenting them as a global library.
const projectSpaces = computed(() =>
  WORKFLOW_SPACES[workflow.value].filter((option) => option !== 'CUSTOMIZED_VOICE_LIBRARY'),
);
const projectSpaceLabel = (option: AssetWorkflowSpace): string =>
  option === 'FISSION_AVATAR' ? '数字人口播项目' : SPACE_LABELS[option];
const projectStatus = (project: Project): string =>
  project.status === 'COMPLETED' ? '已完成' : project.status === 'ACTIVE' ? '进行中' : '草稿';

async function loadProjects(): Promise<void> {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const stamp = ++generation;
  if (!props.open || selectedProject.value) return;
  loading.value = true;
  error.value = '';
  projects.value = [];
  try {
    // Search always remains inside the selected workflow and business space.
    const response = await listProjects(
      { workflow: workflow.value, space: space.value, keyword: keyword.value.trim() },
      request.signal,
    );
    if (!request.signal.aborted && stamp === generation) projects.value = response.data;
  } catch (cause) {
    if (!request.signal.aborted && stamp === generation && !isAbortError(cause))
      error.value = '项目列表加载失败，请稍后重试。';
  } finally {
    if (!request.signal.aborted && stamp === generation) loading.value = false;
  }
}
function setWorkflow(next: AssetWorkflow): void {
  if (creating.value || props.entryBusy || workflow.value === next) return;
  workflow.value = next;
  space.value = WORKFLOW_SPACES[next][0]!;
  keyword.value = '';
  selectedProject.value = null;
}
function enterProject(project: Project): void {
  if (!projectMatchesSpace(project, space.value)) return;
  controller?.abort();
  generation += 1;
  selectedProject.value = project;
}
function backToProjects(): void {
  if (props.entryBusy) return;
  selectedProject.value = null;
  void loadProjects();
}
async function createContextProject(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  error.value = '';
  const scope = { workflow: workflow.value, space: space.value };
  try {
    const response = await createProject({
      name: '未命名营销项目',
      description: '等待补充项目资料',
      client: '待填写客户',
      productName: '待填写产品',
      ...scope,
    });
    await reload();
    selectProject(response.data.id);
    enterProject(response.data);
  } catch {
    error.value = '创建项目失败，请稍后重试。';
  } finally {
    creating.value = false;
  }
}
function close(): void {
  if (creating.value || props.entryBusy) return;
  emit('close');
  void nextTick(() => trigger?.isConnected && trigger.focus());
}
function keepDialogFocus(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !drawer.value) return;
  const controls = Array.from(
    drawer.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === drawer.value)
  ) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
watch([workflow, space], () => {
  selectedProject.value = null;
  projects.value = [];
  error.value = '';
  if (timer) clearTimeout(timer);
  void loadProjects();
});
watch(keyword, () => {
  controller?.abort();
  generation += 1;
  projects.value = [];
  loading.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void loadProjects(), 250);
});
watch(
  () => props.initialWorkflow,
  (next) => {
    if (next !== workflow.value) setWorkflow(next);
  },
);
watch(
  () => props.open,
  (open) => {
    if (open) {
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void nextTick(() => drawer.value?.focus());
      if (!selectedProject.value) void loadProjects();
    } else {
      controller?.abort();
      generation += 1;
      if (timer) clearTimeout(timer);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  controller?.abort();
  if (timer) clearTimeout(timer);
  generation += 1;
});
</script>

<template>
  <Transition name="drawer-fade">
    <div v-if="open" class="asset-overlay" @mousedown.self="close">
      <section
        ref="drawer"
        class="asset-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-title"
        tabindex="-1"
        @keydown.esc="close"
        @keydown="keepDialogFocus"
      >
        <header class="library-header">
          <div>
            <h2 id="asset-title">项目资产库</h2>
            <span>PROJECT LIBRARY</span>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭"
            :disabled="creating || entryBusy"
            @click="close"
          >
            <X :size="19" />
          </button>
        </header>
        <div class="library-shell">
          <nav class="workflow-nav" aria-label="资产工作流">
            <span class="nav-caption">工作流</span>
            <div class="workflow-options" role="tablist" aria-label="工作流">
              <button
                v-for="(meta, key) in WORKFLOW_META"
                :key="key"
                type="button"
                role="tab"
                :aria-selected="workflow === key"
                :disabled="creating || entryBusy"
                @click="setWorkflow(key)"
              >
                <span class="workflow-indicator" />{{ meta.label }}<ChevronRight :size="14" />
              </button>
            </div>
            <div
              v-if="projectSpaces.length > 1"
              class="space-options"
              role="group"
              aria-label="业务分区"
            >
              <span class="nav-caption">业务分区</span
              ><button
                v-for="option in projectSpaces"
                :key="option"
                type="button"
                :disabled="creating || entryBusy"
                :aria-pressed="space === option"
                @click="space = option"
              >
                {{ projectSpaceLabel(option) }}
              </button>
            </div>
            <p>项目内容按工作流独立浏览</p>
          </nav>
          <main class="library-main">
            <header class="content-header">
              <div>
                <button
                  v-if="selectedProject"
                  type="button"
                  class="back-button"
                  aria-label="返回项目列表"
                  :disabled="entryBusy"
                  @click="backToProjects"
                >
                  <ArrowLeft :size="17" />
                </button>
                <div>
                  <h3>{{ selectedProject?.name || WORKFLOW_META[workflow].label + '项目' }}</h3>
                  <p>
                    {{
                      selectedProject
                        ? [selectedProject.productName, selectedProject.client]
                            .filter(Boolean)
                            .join(' · ') || '项目素材与工作流产物'
                        : '选择项目，浏览素材与产物'
                    }}
                  </p>
                </div>
              </div>
              <div v-if="selectedProject" class="project-entry-actions">
                <span v-if="selectedProject.id === currentProject?.id" class="current-mark"
                  >当前项目</span
                >
                <button
                  type="button"
                  class="create-button"
                  :disabled="creating || entryBusy"
                  @click="emit('enterProject', selectedProject.id, workflow, space)"
                >
                  <LoaderCircle v-if="entryBusy" class="spinner" :size="15" /><LogIn
                    v-else
                    :size="15"
                  />
                  {{ entryBusy ? '正在进入…' : '进入项目' }}
                </button>
              </div>
              <button
                v-if="!selectedProject"
                type="button"
                class="create-button"
                :disabled="creating"
                @click="createContextProject"
              >
                <LoaderCircle v-if="creating" class="spinner" :size="15" /><Plus
                  v-else
                  :size="15"
                />新建项目
              </button>
            </header>
            <p v-if="entryError && selectedProject" class="project-entry-error" role="alert">
              {{ entryError }}
            </p>
            <ProjectAssetBrowser
              v-if="selectedProject"
              :key="`${selectedProject.id}:${workflow}:${space}`"
              :project="selectedProject"
              :workflow="workflow"
              :space="space"
              :current-project="currentProject"
              @resume-node="emit('resumeNode', $event)"
            />
            <section v-else class="project-library" :aria-busy="loading">
              <div class="project-toolbar">
                <label
                  ><Search :size="16" /><input
                    v-model="keyword"
                    aria-label="搜索项目"
                    placeholder="搜索项目名称、客户或产品" /><button
                    v-if="keyword"
                    type="button"
                    aria-label="清空项目搜索"
                    @click="keyword = ''"
                  >
                    <X :size="14" /></button></label
                ><span>{{ loading ? '加载中' : `${matchingProjects.length} 个项目` }}</span
                ><button
                  type="button"
                  class="icon-button"
                  aria-label="刷新项目列表"
                  :disabled="loading || creating"
                  @click="loadProjects"
                >
                  <RefreshCw :size="16" />
                </button>
              </div>
              <div v-if="loading" class="library-state">
                <LoaderCircle class="spinner" :size="24" />
                <p>正在加载项目…</p>
              </div>
              <div v-else-if="error" class="library-state" role="alert">
                <h4>项目暂时无法显示</h4>
                <p>{{ error }}</p>
                <button type="button" @click="loadProjects">重新加载</button>
              </div>
              <div v-else-if="!matchingProjects.length" class="library-state">
                <Folder :size="32" />
                <h4>{{ keyword ? '没有匹配的项目' : '暂无项目' }}</h4>
                <p>
                  {{ keyword ? '试试其他名称或关键词。' : '该工作流中创建的项目会显示在这里。' }}
                </p>
              </div>
              <div v-else class="project-list">
                <div class="project-columns" aria-hidden="true">
                  <span>项目名称</span><span>产品 / 客户</span><span>状态</span><span>更新于</span
                  ><span />
                </div>
                <button
                  v-for="project in matchingProjects"
                  :key="project.id"
                  type="button"
                  class="project-row"
                  @click="enterProject(project)"
                >
                  <span class="project-name"
                    ><span class="folder-icon"><Folder :size="21" /></span
                    ><span
                      ><strong>{{ project.name }}</strong
                      ><small
                        v-if="project.description && project.description !== '等待补充项目资料'"
                        >{{ project.description }}</small
                      ></span
                    ><i v-if="project.id === currentProject?.id">当前</i></span
                  ><span class="project-client">{{
                    [project.productName, project.client]
                      .filter((value) => value && !value.startsWith('待填写'))
                      .join(' / ') || '—'
                  }}</span
                  ><span class="project-status"
                    ><i :class="project.status.toLowerCase()" />{{ projectStatus(project) }}</span
                  ><span class="project-date">{{ formatAssetTime(project.updatedAt) }}</span
                  ><ChevronRight :size="16" />
                </button>
              </div>
            </section>
          </main>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.asset-overlay {
  position: fixed;
  z-index: 200;
  inset: 0;
  display: grid;
  place-items: center;
  background: #17263f66;
  padding: 24px;
  box-sizing: border-box;
}
.asset-drawer {
  display: flex;
  flex-direction: column;
  width: min(1440px, 100%);
  height: min(940px, calc(100dvh - 48px));
  min-height: 0;
  background: #fff;
  border: 1px solid #dce5f2;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 24px 90px #17263f29;
  outline: none;
  color: #17263f;
  font-size: 13px;
}
button,
input {
  font: inherit;
}
button {
  cursor: pointer;
  color: inherit;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
.library-header {
  height: 72px;
  padding: 0 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e4eaf4;
  flex-shrink: 0;
}
.library-header > div {
  display: flex;
  align-items: baseline;
  gap: 16px;
}
.library-header h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.3px;
}
.library-header span {
  font-size: 10px;
  color: #72809a;
  letter-spacing: 1.5px;
}
.icon-button {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #72809a;
}
.icon-button:hover {
  background: #eaf1ff;
  color: #17263f;
}
.library-shell {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}
.workflow-nav {
  background: #f8faff;
  border-right: 1px solid #e4eaf4;
  padding: 26px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.nav-caption {
  color: #72809a;
  font-size: 11px;
  padding: 0 12px;
}
.workflow-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.workflow-options button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 0;
  background: transparent;
  color: #526582;
  text-align: left;
  border-radius: 5px;
  font-size: 13px;
}
.workflow-options button svg {
  margin-left: auto;
  opacity: 0;
}
.workflow-options button[aria-selected='true'] {
  background: #eaf1ff;
  color: #2563eb;
  font-weight: 600;
}
.workflow-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9aabc2;
}
.workflow-options button[aria-selected='true'] .workflow-indicator {
  background: #2563eb;
}
.space-options {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 20px;
}
.space-options > span {
  margin-bottom: 5px;
}
.space-options button {
  text-align: left;
  background: transparent;
  border: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: #72809a;
}
.space-options button[aria-pressed='true'] {
  color: #2563eb;
  font-weight: 600;
}
.workflow-nav > p {
  margin-top: auto;
  padding: 0 12px;
  color: #72809a;
  font-size: 10px;
  line-height: 1.6;
}
.library-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.content-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 25px 28px 18px;
  flex-shrink: 0;
}
.content-header > div {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.content-header h3 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.content-header p {
  margin: 7px 0 0;
  color: #72809a;
  font-size: 12px;
}
.back-button {
  border: 1px solid #dce5f2;
  background: #fff;
  border-radius: 5px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  color: #526582;
  flex-shrink: 0;
}
.create-button {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid #2563eb;
  background: #2563eb;
  color: #fff;
  border-radius: 5px;
  font-size: 12px;
  white-space: nowrap;
}
.current-mark {
  font-size: 11px;
  color: #2563eb;
  white-space: nowrap;
}
.project-entry-actions {
  flex-shrink: 0;
}
.project-entry-error {
  margin: 0 28px 12px;
  padding: 10px 12px;
  color: #b42318;
  background: #fff5f4;
  border: 1px solid #fecaca;
  border-radius: 6px;
}
.project-library {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}
.project-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 0 28px 22px;
  border-bottom: 1px solid #e4eaf4;
}
.project-toolbar label {
  width: min(400px, 60%);
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid #dce5f2;
  border-radius: 5px;
  height: 36px;
  padding: 0 10px;
  color: #72809a;
}
.project-toolbar input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: 0;
  color: #17263f;
  font-size: 13px;
}
.project-toolbar label button {
  border: 0;
  padding: 0;
  background: transparent;
  color: #72809a;
  display: grid;
  place-items: center;
}
.project-toolbar > span {
  margin-left: auto;
  font-size: 12px;
  color: #72809a;
  white-space: nowrap;
}
.project-list {
  overflow: auto;
  padding: 0 28px 28px;
  min-height: 0;
}
.project-columns,
.project-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) 90px 110px 18px;
  gap: 24px;
  align-items: center;
}
.project-columns {
  padding: 16px 12px;
  font-size: 11px;
  color: #72809a;
}
.project-row {
  width: 100%;
  padding: 20px 12px;
  border: 0;
  border-top: 1px solid #edf1f7;
  background: transparent;
  text-align: left;
}
.project-row:hover {
  background: #f3f7ff;
}
.project-name {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.folder-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  background: #eaf1ff;
  border-radius: 6px;
  color: #2563eb;
}
.project-name > span:last-of-type {
  min-width: 0;
}
.project-name strong {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  display: block;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.project-name small {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: #72809a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.project-name > i {
  font-size: 10px;
  color: #2563eb;
  background: #eaf1ff;
  font-style: normal;
  padding: 3px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.project-client,
.project-date {
  font-size: 12px;
  color: #72809a;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.project-row > svg {
  color: #9aabc2;
}
.project-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #526582;
}
.project-status i {
  height: 5px;
  width: 5px;
  border-radius: 50%;
  background: #9aabc2;
}
.project-status i.active {
  background: #27a475;
}
.library-state {
  display: flex;
  flex: 1;
  min-height: 250px;
  padding: 30px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  text-align: center;
  color: #72809a;
}
.library-state h4 {
  margin: 7px 0 0;
  font-size: 15px;
  font-weight: 500;
  color: #526582;
}
.library-state p {
  margin: 4px 0;
  font-size: 12px;
}
.library-state button {
  margin-top: 10px;
  border: 1px solid #dce5f2;
  border-radius: 5px;
  background: #fff;
  color: #2563eb;
  padding: 8px 14px;
  font-size: 12px;
}
.workflow-options button:hover,
.space-options button:hover {
  background: #eaf1ff;
  color: #2563eb;
}
.create-button:hover:not(:disabled) {
  background: #1d4ed8;
  border-color: #1d4ed8;
}
.back-button:hover,
.library-state button:hover {
  color: #2563eb;
  border-color: #b8cefa;
  background: #f3f7ff;
}
.project-toolbar label:focus-within {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px #2563eb14;
}
.spinner {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 0.15s;
}
.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}
@media (max-width: 1100px) {
  .library-shell {
    grid-template-columns: 155px minmax(0, 1fr);
  }
  .project-columns,
  .project-row {
    grid-template-columns: minmax(0, 1fr) 80px 110px 18px;
    gap: 12px;
  }
  .project-client,
  .project-columns > span:nth-child(2) {
    display: none;
  }
}
@media (max-width: 760px) {
  .asset-overlay {
    padding: 8px;
  }
  .asset-drawer {
    height: calc(100dvh - 16px);
    border-radius: 8px;
  }
  .library-header {
    height: 58px;
    padding: 0 18px;
  }
  .library-header span {
    display: none;
  }
  .library-shell {
    display: flex;
    flex-direction: column;
  }
  .workflow-nav {
    padding: 10px 16px 0;
    border-right: 0;
    border-bottom: 1px solid #e4eaf4;
    gap: 6px;
    flex-shrink: 0;
  }
  .workflow-nav > .nav-caption,
  .workflow-nav > p {
    display: none;
  }
  .workflow-options {
    flex-direction: row;
    gap: 12px;
  }
  .workflow-options button {
    flex: 1;
    justify-content: center;
    padding: 9px;
  }
  .workflow-options svg {
    display: none;
  }
  .space-options {
    flex-direction: row;
    flex-wrap: wrap;
    margin-top: 0;
    gap: 0;
  }
  .space-options .nav-caption {
    display: none;
  }
  .space-options button {
    font-size: 11px;
    padding: 10px;
  }
  .library-main {
    flex: 1;
  }
  .content-header {
    padding: 20px 16px 16px;
  }
  .content-header h3 {
    font-size: 17px;
  }
  .project-toolbar {
    padding: 0 16px 16px;
  }
  .project-toolbar label {
    width: auto;
    flex: 1;
  }
  .project-toolbar > span {
    display: none;
  }
  .project-list {
    padding: 0 16px 16px;
  }
  .project-columns {
    display: none;
  }
  .project-row {
    grid-template-columns: minmax(0, 1fr) 75px 16px;
    gap: 10px;
    padding: 18px 0;
  }
  .project-date {
    display: none;
  }
  .project-name {
    gap: 10px;
  }
  .folder-icon {
    width: 36px;
    height: 36px;
  }
  .project-name strong {
    font-size: 13px;
  }
  .project-name > i {
    display: none;
  }
}
</style>
