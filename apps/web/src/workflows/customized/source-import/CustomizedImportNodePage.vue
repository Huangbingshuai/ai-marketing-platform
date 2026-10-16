<script setup lang="ts">
import {
  normalizeCustomizedImportDraft,
  customizedWorkflowNodeId,
  customizedMaterialSection,
  type CustomizedImportSection,
  type CustomizedImageUsage,
  type Asset,
  type WorkflowRun,
  type CustomizedWorkflowBranchTreeData,
  type CustomizedImportDraftState,
  type CustomizedMaterialCategory,
  type DeleteStoryboardScriptResult,
} from '@ai-marketing/contracts';
import { WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertCircle,
  Download,
  FileText,
  LoaderCircle,
  Trash2,
  Image as ImageIcon,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import ImportSourceCard from '../../../platform/file/components/ImportSourceCard.vue';
import ImportDropzone from '../../../platform/file/components/ImportDropzone.vue';
import ImportMaterialRow from '../../../platform/file/components/ImportMaterialRow.vue';
import ImportContentViewer from '../../../platform/file/components/ImportContentViewer.vue';
import ImportImagePreview from '../../../platform/file/components/ImportImagePreview.vue';
import { ApiClientError } from '../../../api/http-client';
import { getAssetVersion } from '../../../platform/asset/api/asset.api';
import { useProjectContext } from '../../../platform/project/project-context';
import {
  activateWorkflowNode,
  getActiveWorkflowRunOverview,
  listWorkingArtifacts,
  putWorkflowNodeState,
} from '../../../platform/workflow/api/workflow-working.api';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import WorkflowEditingBanner from '../../../platform/workflow/components/WorkflowEditingBanner.vue';
import WorkflowNavigationFeedback from '../../../platform/workflow/components/WorkflowNavigationFeedback.vue';
import { createWorkflowNodeActivationQueue } from '../../../platform/workflow/workflow-node-activation';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import { confirmDiscardEffectEdit } from '../../effect/shared/effect-edit-session';
import { buildCustomizedBranchLayout, customizedBranchStages } from '../customized-branch-layout';
import EffectWorkflowBranchTree from '../../effect/source-import/components/EffectWorkflowBranchTree.vue';
import EffectWorkflowCanvas from '../../effect/source-import/components/EffectWorkflowCanvas.vue';
import EffectUpwardCreatableSelect from '../../effect/source-import/components/EffectUpwardCreatableSelect.vue';
import { customizedWorkflowNodes } from '../customized-workflow';
import CustomizedInfoExtractionNodePage from '../information-extraction/CustomizedExtractionWorkspace.vue';
import CustomizedStoryboardWorkspace from '../storyboard/CustomizedStoryboardWorkspace.vue';
import CustomizedProductionWorkspace from '../production/CustomizedProductionWorkspace.vue';
import { storyboardApi } from '../storyboard/storyboard.api';
import type { CustomizedExtractionSource } from '../information-extraction/customized-extraction-view';
import {
  initializeCustomizedDraft,
  uploadCustomizedMaterial,
  getCustomizedBranchTree,
  beginCustomizedEdit,
  cancelCustomizedEdit,
  saveCustomizedVersion,
  activateCustomizedBranch,
} from './api/customized-import.api';
import {
  customizedImageUsageOptions,
  createCustomizedDraftPersistence,
  emptyCustomizedImportDraft,
  isCustomizedSourceAsset,
  isCustomizedImage,
  sectionFileError,
  restoreCustomizedImportWorkspace,
  validateCustomizedImportDraft,
} from './customized-import-state';

import {
  CUSTOMIZED_REQUIREMENTS_TEMPLATE_URL,
  CUSTOMIZED_REQUIREMENTS_TEMPLATE_NAME,
} from './customized-requirements-template';

const context = useProjectContext();
const projectId = context.currentProject.value!.id;
const draft = ref<CustomizedImportDraftState>(emptyCustomizedImportDraft());
const workflowRunId = ref('');
const activeStep = ref(0);
const storyboardViewedRunId = ref<string | null>(null);
const activeRun = ref<WorkflowRun | null>(null);
const branchTree = ref<CustomizedWorkflowBranchTreeData | null>(null);
const branchOpen = ref(false);
const branchLoading = ref(false);
const branchError = ref('');
const branchSwitching = ref(false);
const versionSaving = ref(false);
const editBusy = ref(false);
let branchController: AbortController | undefined;
const branchLayout = computed(() =>
  branchTree.value
    ? buildCustomizedBranchLayout(branchTree.value, {
        nodeId: customizedWorkflowNodes[activeStep.value]!.id,
        scriptRunId: storyboardViewedRunId.value,
      })
    : undefined,
);
const publishedBranch = computed(() =>
  branchTree.value?.branches.find((branch) => branch.isActive),
);
const confirmedSteps = computed(() =>
  customizedWorkflowNodes.flatMap((node, index) =>
    publishedBranch.value?.nodes.some(
      (state) => state.nodeId === node.id && state.artifactCount > 0,
    )
      ? [index]
      : [],
  ),
);
const temporaryEdit = computed(() =>
  Boolean(activeRun.value?.isTemporaryBranch && activeRun.value.editNodeId === 'SOURCE_IMPORT'),
);
const sourceEditing = computed(() => temporaryEdit.value || !confirmedSteps.value.includes(0));
const canvasNodes = computed(() =>
  customizedWorkflowNodes.map((node, index) => ({
    ...node,
    status:
      index === activeStep.value
        ? '当前'
        : confirmedSteps.value.includes(index)
          ? '已确认'
          : '就绪',
  })),
);
const staleCounts = computed(() =>
  customizedWorkflowNodes.map((node) =>
    publishedBranch.value?.nodes.find((state) => state.nodeId === node.id)?.status === 'STALE'
      ? 1
      : 0,
  ),
);
const loading = ref(true);
const loadError = ref('');
const actionError = ref('');
const saveStatus = ref<'empty' | 'dirty' | 'saving' | 'saved' | 'error'>('empty');
const assets = ref<Record<string, Asset>>({});
const materialErrors = ref<Record<string, string>>({});
const pendingFiles = ref<
  {
    id: string;
    file: File;
    category: CustomizedMaterialCategory;
    imageUsage?: CustomizedImageUsage;
    error: string;
  }[]
>([]);
const uploading = ref(false);
const transitioning = ref(false);
const pendingStep = ref<number | null>(null);
const pendingStepLabel = computed(() =>
  pendingStep.value === null
    ? null
    : (customizedWorkflowNodes[pendingStep.value]?.title ?? '目标节点'),
);
const runContextSwitching = ref(false);
const branchSwitchToast = ref('');
let branchToastTimer: ReturnType<typeof setTimeout> | undefined;
const showBranchSwitchToast = (text: string) => {
  branchSwitchToast.value = text;
  clearTimeout(branchToastTimer);
  branchToastTimer = setTimeout(() => {
    branchSwitchToast.value = '';
  }, 2800);
};
const notice = ref('');
let disposed = false;
let loadController: AbortController | undefined;
let uploadController: AbortController | undefined;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let persistence: ReturnType<typeof createCustomizedDraftPersistence> | undefined;
const busy = computed(
  () =>
    loading.value ||
    branchSwitching.value ||
    uploading.value ||
    transitioning.value ||
    editBusy.value ||
    versionSaving.value,
);
const currentNode = computed(() => customizedWorkflowNodes[activeStep.value]!);
const statusLabel = computed(
  () =>
    ({
      empty: '尚未填写',
      dirty: '有待保存修改',
      saving: '正在保存…',
      saved: '草稿已保存',
      error: '保存失败',
    })[saveStatus.value],
);
const sourceReady = computed(() =>
  draft.value.materials.every(
    (item) => assets.value[item.assetId] && !materialErrors.value[item.assetId],
  ),
);
const extractionSourceConfirmed = computed(
  () => confirmedSteps.value.includes(0) && !sourceEditing.value,
);
const extractionSources = computed<CustomizedExtractionSource[]>(() =>
  extractionSourceConfirmed.value
    ? draft.value.materials.map((reference) => ({
        reference,
        asset: assets.value[reference.assetId] ?? null,
        ...(materialErrors.value[reference.assetId]
          ? { error: materialErrors.value[reference.assetId] }
          : {}),
      }))
    : [],
);
const safeError = (error: unknown, fallback: string) =>
  error instanceof ApiClientError && error.status < 500 ? error.message : fallback;
const snapshot = (): CustomizedImportDraftState => JSON.parse(JSON.stringify(draft.value));

const scheduleSave = () => {
  if (disposed || loading.value || !sourceEditing.value || !persistence) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  saveStatus.value = 'dirty';
  autosaveTimer = setTimeout(() => {
    void persistence?.flush();
  }, 650);
};
watch(draft, scheduleSave, { deep: true });

const nodeActivation = createWorkflowNodeActivationQueue<{ runId: string; step: number }>({
  activate: async (target) => {
    if (!target.runId) target.runId = workflowRunId.value;
    if (!target.runId) {
      const { data } = await initializeCustomizedDraft(projectId);
      if (disposed) return;
      workflowRunId.value = data.run.id;
      activeRun.value = data.run;
      target.runId = data.run.id;
    }
    await activateWorkflowNode(projectId, target.runId, customizedWorkflowNodes[target.step]!.id);
  },
  isCurrent: ({ runId }) => !disposed && (!runId || workflowRunId.value === runId),
  onError: (error) => {
    notice.value = `页面已切换，节点状态后台同步失败：${safeError(error, '请再次切换重试')}`;
  },
});

const load = async (options: { preserveView?: boolean } = {}) => {
  const preserveView = options.preserveView ?? false;
  const previousStep = activeStep.value;
  const previousScrollY = window.scrollY;
  nodeActivation.invalidate();
  runContextSwitching.value = preserveView;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  branchController?.abort();
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loading.value = true;
  loadError.value = '';
  actionError.value = '';
  notice.value = '';
  try {
    const overviewPromise = getActiveWorkflowRunOverview(
      projectId,
      'CUSTOMIZED',
      'CUSTOMIZED_PROJECT',
      controller.signal,
    );
    const treePromise = getCustomizedBranchTree(projectId, controller.signal).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const { data } = await overviewPromise;
    if (disposed || controller.signal.aborted) return;
    if (
      data.run &&
      (data.run.projectId !== projectId ||
        data.run.workflow !== 'CUSTOMIZED' ||
        data.run.workflowSpace !== 'CUSTOMIZED_PROJECT')
    )
      throw new Error('工作流作用域不匹配');
    const state = data.nodeStates.find(
      (item) =>
        item.nodeId === 'SOURCE_IMPORT' &&
        item.projectId === projectId &&
        item.workflowRunId === data.run?.id,
    );
    const artifacts = data.run
      ? (
          await listWorkingArtifacts(
            projectId,
            {
              workflowRunId: data.run.id,
              workflow: 'CUSTOMIZED',
              space: 'CUSTOMIZED_PROJECT',
              nodeId: 'SOURCE_IMPORT',
              view: 'SNAPSHOT',
            },
            controller.signal,
          )
        ).data.items
      : [];
    if (disposed || controller.signal.aborted) return;
    const nextDraft = restoreCustomizedImportWorkspace(
      projectId,
      data.run,
      data.nodeStates,
      artifacts,
    );
    const assetLoads = Promise.allSettled(
      nextDraft.materials.map(async (item) => {
        const { data: asset } = await getAssetVersion(
          projectId,
          item.assetId,
          item.assetVersion,
          controller.signal,
        );
        if (!isCustomizedSourceAsset(asset, projectId)) throw new Error('资料不可用');
        return asset;
      }),
    );
    const treeResult = await treePromise;
    if (!treeResult.ok) throw treeResult.error;
    const tree = treeResult.result;
    if (
      tree.data.projectId !== projectId ||
      tree.data.activeWorkflowRunId !== (data.run?.id ?? null)
    )
      throw new ApiClientError('工作流版本已切换，请重新加载', 409);
    const nextAssets: Record<string, Asset> = {};
    const nextErrors: Record<string, string> = {};
    const loaded = await assetLoads;
    if (disposed || controller.signal.aborted) return;
    loaded.forEach((result, index) => {
      const item = nextDraft.materials[index]!;
      if (result.status === 'fulfilled') {
        nextAssets[item.assetId] = result.value;
        if ((result.value.currentVersion ?? 1) !== item.assetVersion)
          nextErrors[item.assetId] = '项目资产已有新版本，请移除后重新选择';
      } else nextErrors[item.assetId] = '资料暂不可用，请重试加载或重新选择';
    });
    // Publish the complete scope together, keeping the previous node visible while it loads.
    activeRun.value = data.run;
    branchTree.value = tree.data;
    draft.value = normalizeCustomizedImportDraft(
      nextDraft,
      new Set(
        Object.values(nextAssets)
          .filter(isCustomizedImage)
          .map((asset) => asset.id),
      ),
    );
    // Historical non-image references remain visible in requirements.
    draft.value.materials.forEach((item) => {
      if (
        item.category === 'VISUAL_REFERENCE' &&
        nextAssets[item.assetId] &&
        !isCustomizedImage(nextAssets[item.assetId]!)
      )
        item.category = 'BRIEF';
    });
    workflowRunId.value = data.run?.id ?? '';
    const step = customizedWorkflowNodes.findIndex(
      (node) => node.id === customizedWorkflowNodeId(data.run?.currentNodeId),
    );
    activeStep.value = preserveView ? previousStep : step < 0 ? 0 : step;
    assets.value = nextAssets;
    materialErrors.value = nextErrors;
    persistence = createCustomizedDraftPersistence(
      {
        snapshot,
        initialize: async () => {
          const { data: initialized } = await initializeCustomizedDraft(projectId);
          if (
            initialized.run.projectId !== projectId ||
            initialized.run.workflow !== 'CUSTOMIZED' ||
            initialized.run.workflowSpace !== 'CUSTOMIZED_PROJECT'
          )
            throw new Error('工作流作用域不匹配');
          if (!disposed) workflowRunId.value = initialized.run.id;
          return initialized.run.id;
        },
        put: async (runId, revision, state) => {
          const result = await putWorkflowNodeState(projectId, runId, 'SOURCE_IMPORT', {
            expectedRevision: revision,
            schemaVersion: 3,
            state,
          });
          return result.data.nodeState.revision;
        },
        status: (status, error) => {
          if (disposed) return;
          saveStatus.value = status;
          if (status === 'error')
            actionError.value =
              error instanceof ApiClientError && error.status === 409
                ? '草稿已在其他页面更新。当前编辑仍保留，请备份内容后重新加载。'
                : safeError(error, '草稿保存失败，请重试。当前编辑仍保留。');
          else if (status === 'saved') actionError.value = '';
        },
      },
      { runId: workflowRunId.value, revision: state?.revision ?? null, state: snapshot() },
    );
    saveStatus.value = state ? 'saved' : 'empty';
    await nextTick();
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      controller.abort();
      loadError.value = safeError(error, '资料草稿加载失败，请重新加载');
      loading.value = false;
      runContextSwitching.value = false;
    }
  } finally {
    if (!disposed && !controller.signal.aborted) {
      loading.value = false;
      runContextSwitching.value = false;
      if (preserveView && !loadError.value) {
        await nextTick();
        requestAnimationFrame(() => window.scrollTo({ top: previousScrollY, behavior: 'auto' }));
      }
    }
  }
};
void load();

const save = async (): Promise<boolean> => {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  if (!persistence || loadError.value || loading.value) return false;
  return persistence.flush();
};
const extractionWorkspace = ref<InstanceType<typeof CustomizedInfoExtractionNodePage> | null>(null);
const storyboardWorkspace = ref<InstanceType<typeof CustomizedStoryboardWorkspace> | null>(null);
const productionWorkspace = ref<InstanceType<typeof CustomizedProductionWorkspace> | null>(null);
const flushPendingEdits = async (): Promise<boolean> => {
  if (productionWorkspace.value && !(await productionWorkspace.value.flushPendingEdits()))
    return false;
  if (storyboardWorkspace.value && !(await storyboardWorkspace.value.flushPendingEdits()))
    return false;
  if (extractionWorkspace.value && !(await extractionWorkspace.value.flushPendingEdits()))
    return false;
  if (uploading.value || pendingFiles.value.length) {
    actionError.value = '请先将所选文件保存到项目资产库，或移除待保存文件，再切换或退出。';
    return false;
  }
  if (loadError.value || loading.value) return true;
  return sourceEditing.value ? save() : true;
};
const reload = async () => {
  if (busy.value || saveStatus.value === 'saving') return;
  if (
    (persistence?.dirty() || pendingFiles.value.length) &&
    !(await requestActionConfirmation({
      title: '重新加载资料草稿？',
      description: '当前尚未保存的文字和所选文件会被已保存资料替换，请先备份需要保留的内容。',
      confirmLabel: '重新加载',
    }))
  )
    return;
  pendingFiles.value = [];
  await load();
};
const selectStep = async (step: number) => {
  if (
    step < 0 ||
    step >= customizedWorkflowNodes.length ||
    busy.value ||
    loadError.value ||
    step === activeStep.value
  )
    return;
  if (activeStep.value === 2 && step > 2) {
    const runId = await storyboardWorkspace.value?.nextRunId();
    if (runId)
      await selectBranch({ workflowRunId: runId, nodeId: customizedWorkflowNodes[step]!.id });
    else actionError.value = '请先保存当前脚本，并确认其来源有效，再进入后续节点。';
    return;
  }
  if (step > 2 && activeStep.value < 2) {
    if (!(await flushPendingEdits())) return;
    try {
      const catalog = await storyboardApi.workspace(projectId, workflowRunId.value);
      const selected =
        catalog.scripts.find((s) => s.id === catalog.selectedScriptId) ?? catalog.scripts[0];
      if (
        !selected?.workflowRunId ||
        !selected.confirmedRevision ||
        selected.stale ||
        selected.editing
      ) {
        actionError.value = '请先选择并保存完整脚本，再进入制作。';
        return;
      }
      await selectBranch({
        workflowRunId: selected.workflowRunId,
        nodeId: customizedWorkflowNodes[step]!.id,
      });
    } catch (e) {
      actionError.value = e instanceof Error ? e.message : '脚本目录暂时不可用';
    }
    return;
  }
  pendingStep.value = step;
  transitioning.value = true;
  try {
    if (!(await flushPendingEdits())) return;
    activeStep.value = step;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    nodeActivation.enqueue({ runId: workflowRunId.value, step });
  } finally {
    if (!disposed) {
      pendingStep.value = null;
      transitioning.value = false;
    }
  }
};
const resumeWorkflowNode = async (nodeId: string): Promise<boolean> => {
  const index = customizedWorkflowNodes.findIndex(
    (node) => node.id === customizedWorkflowNodeId(nodeId),
  );
  if (index < 0) return false;
  await selectStep(index);
  return activeStep.value === index;
};
defineExpose({ flushPendingEdits, resumeWorkflowNode, workflowRunId });

const beginEdit = async () => {
  if (busy.value || sourceEditing.value || !workflowRunId.value) return;
  editBusy.value = true;
  try {
    await nodeActivation.drain();
    await beginCustomizedEdit(projectId, workflowRunId.value);
    await load({ preserveView: true });
  } catch (error) {
    actionError.value = safeError(error, '进入资料编辑失败，请重试');
  } finally {
    if (!disposed) editBusy.value = false;
  }
};
const cancelEdit = async () => {
  if (busy.value || !temporaryEdit.value) return;
  const runId = workflowRunId.value;
  if (!(await confirmDiscardEffectEdit()) || disposed || workflowRunId.value !== runId) return;
  editBusy.value = true;
  try {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    // Drain an in-flight auto-save before deleting its isolated Run.
    await persistence?.flush();
    await nodeActivation.drain();
    await cancelCustomizedEdit(projectId, runId);
    pendingFiles.value = [];
    await load({ preserveView: true });
    notice.value = '已取消编辑，返回原资料版本';
  } catch (error) {
    actionError.value = safeError(error, '取消资料编辑失败，请重试');
  } finally {
    if (!disposed) editBusy.value = false;
  }
};
const saveVersion = async () => {
  if (busy.value || !sourceEditing.value) return;
  const issues = temporaryEdit.value ? [] : validateCustomizedImportDraft(draft.value);
  if (!sourceReady.value || pendingFiles.value.length) issues.push('请先保存并处理资料引用');
  if (issues.length) {
    actionError.value = issues.join('；');
    return;
  }
  versionSaving.value = true;
  try {
    if (!(await save())) return;
    const revision = persistence?.revision();
    if (!workflowRunId.value || !revision) return;
    await nodeActivation.drain();
    const { data } = await saveCustomizedVersion(projectId, workflowRunId.value, revision);
    if (disposed) return;
    await load({ preserveView: true });
    notice.value = data.unchanged
      ? '资料内容未变化，保持当前版本'
      : data.createdBranch
        ? '资料版本已保存，已创建新分支'
        : '资料版本已保存';
  } catch (error) {
    if (!disposed) actionError.value = safeError(error, '资料版本保存失败，请重试');
  } finally {
    if (!disposed) versionSaving.value = false;
  }
};
const loadBranchTree = async (skipFlush = false) => {
  branchController?.abort();
  const controller = new AbortController();
  branchController = controller;
  branchLoading.value = true;
  branchError.value = '';
  try {
    if (!skipFlush && !(await flushPendingEdits()))
      throw new Error('节点草稿保存失败，请处理后查看版本树');
    await nodeActivation.drain();
    const { data } = await getCustomizedBranchTree(projectId, controller.signal);
    if (!disposed && branchController === controller && !controller.signal.aborted)
      branchTree.value = data;
  } catch (error) {
    if (!disposed && !controller.signal.aborted)
      branchError.value = safeError(error, '加载版本分支树失败，请重试');
  } finally {
    if (!disposed && branchController === controller) branchLoading.value = false;
  }
};
const openBranchTree = () => {
  branchOpen.value = true;
  void loadBranchTree();
};
const onStoryboardDeleted = async (result: DeleteStoryboardScriptResult) => {
  if (disposed) return;
  if (result.removedRunIds.includes(workflowRunId.value)) {
    storyboardViewedRunId.value = null;
    await load();
  }
  await loadBranchTree(true);
};
const closeBranchTree = () => {
  if (branchSwitching.value) return;
  branchOpen.value = false;
  branchController?.abort();
};
const selectBranch = async (target: { workflowRunId: string; nodeId: string }) => {
  const step = customizedWorkflowNodes.findIndex((node) => node.id === target.nodeId);
  if (step < 0 || busy.value || branchSwitching.value) return;
  branchSwitching.value = true;
  try {
    if (!(await flushPendingEdits())) return;
    await nodeActivation.drain();
    // A script card selects a view in the shared workspace. Only navigation
    // into a downstream node activates the selected script's storage Run.
    if (target.nodeId === 'STORYBOARD') {
      if (storyboardWorkspace.value) {
        if (!(await storyboardWorkspace.value.selectByRun(target.workflowRunId))) return;
      } else {
        storyboardViewedRunId.value = target.workflowRunId;
        activeStep.value = step;
        nodeActivation.enqueue({ runId: workflowRunId.value, step });
      }
      branchOpen.value = false;
      branchController?.abort();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const switchedRun = workflowRunId.value !== target.workflowRunId;
    if (switchedRun) await activateCustomizedBranch(projectId, target.workflowRunId, target.nodeId);
    if (disposed) return;
    branchOpen.value = false;
    branchController?.abort();
    if (switchedRun) {
      storyboardViewedRunId.value = null;
      await load();
    } else {
      activeStep.value = step;
      nodeActivation.enqueue({ runId: target.workflowRunId, step });
    }
    if (!disposed && !loadError.value) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (switchedRun) showBranchSwitchToast('已切换至所选版本分支及节点');
    }
  } catch (error) {
    if (!disposed) branchError.value = safeError(error, '切换版本分支失败，请重试');
  } finally {
    if (!disposed) branchSwitching.value = false;
  }
};

const chooseFiles = (files: File[], section: CustomizedImportSection) => {
  if (busy.value || !sourceEditing.value) return;
  actionError.value = '';
  for (const file of files) {
    const error = sectionFileError(file, section);
    if (error) {
      actionError.value = `${file.name}：${error}`;
      continue;
    }
    const duplicate = pendingFiles.value.some(
      (item) =>
        item.file.name === file.name &&
        item.file.size === file.size &&
        item.file.lastModified === file.lastModified,
    );
    if (duplicate) continue;
    pendingFiles.value.push({ id: crypto.randomUUID(), file, category: section, error: '' });
  }
  if (pendingFiles.value.length) void storeFiles();
};
const storeFiles = async () => {
  if (busy.value || !sourceEditing.value || !pendingFiles.value.length) return;
  uploading.value = true;
  actionError.value = '';
  uploadController = new AbortController();
  const controller = uploadController;
  try {
    if (!workflowRunId.value) {
      const { data } = await initializeCustomizedDraft(projectId);
      if (disposed || controller.signal.aborted) return;
      workflowRunId.value = data.run.id;
      activeRun.value = data.run;
    }
    const uploadRunId = workflowRunId.value;
    for (const item of [...pendingFiles.value]) {
      if (disposed || controller.signal.aborted) break;
      try {
        const { data: asset } = await uploadCustomizedMaterial(
          projectId,
          uploadRunId,
          item.category as CustomizedImportSection,
          item.file,
          controller.signal,
        );
        if (disposed || controller.signal.aborted || workflowRunId.value !== uploadRunId) break;
        if (!asset || !isCustomizedSourceAsset(asset, projectId))
          throw new Error('资料上传结果不完整');
        assets.value[asset.id] = asset;
        const previous = draft.value.materials.find((material) => material.assetId === asset.id);
        if (previous) {
          previous.assetVersion = asset.currentVersion ?? 1;
          previous.category = item.category;
          if (item.imageUsage) previous.imageUsage = item.imageUsage;
        } else
          draft.value.materials.push({
            assetId: asset.id,
            assetVersion: asset.currentVersion ?? 1,
            category: item.category,
            ...(item.imageUsage ? { imageUsage: item.imageUsage } : {}),
          });
        delete materialErrors.value[asset.id];
        pendingFiles.value = pendingFiles.value.filter((candidate) => candidate.id !== item.id);
        if (!(await save())) break;
      } catch (error) {
        if (disposed || controller.signal.aborted) break;
        item.error = safeError(error, '上传失败，请重试');
        actionError.value = '部分文件保存失败，成功项已保留，请重试剩余文件。';
      }
    }
    if (!pendingFiles.value.length && saveStatus.value !== 'error')
      notice.value = '资料已保存到当前项目资产库，资料包草稿已同步。';
  } catch (error) {
    if (!disposed && !controller.signal.aborted)
      actionError.value = safeError(error, '资料上传初始化失败，请重试');
  } finally {
    if (!disposed) uploading.value = false;
  }
};
const removeMaterial = (assetId: string) => {
  if (!sourceEditing.value || busy.value) return;
  draft.value.materials = draft.value.materials.filter((item) => item.assetId !== assetId);
  delete materialErrors.value[assetId];
  notice.value = '已移除资料包引用；原文件仍保留在当前项目资产库。';
};
const next = async () => {
  if (sourceEditing.value || !confirmedSteps.value.includes(0)) {
    actionError.value = '请先保存资料版本，再进入标准化提炼';
    return;
  }
  const errors = validateCustomizedImportDraft(draft.value);
  if (pendingFiles.value.length) errors.push('请先保存所选文件到项目资产库');
  if (!sourceReady.value) errors.push('请处理不可用的资料引用');
  if (errors.length) {
    actionError.value = errors.join('；');
    return;
  }
  await selectStep(1);
};
const documentAccept = '.docx,.pdf,.xlsx,.txt,.md';
const imageAccept = '.jpg,.jpeg,.png,.webp,.psd';
const sections = [
  {
    id: 'BRIEF',
    title: '视频创作简报',
    description: '在一份文档中整合制作目标、产品信息和创作安排，可补充多份文档',
    prompt: '点击或将视频创作简报文档拖拽到此处',
  },
  {
    id: 'VISUAL_REFERENCE',
    title: '品牌素材',
    description: '可选 · 上传已有品牌元素，供后续视觉资产生成使用',
    prompt: '点击或将品牌素材图片拖拽到此处',
  },
] as const;
const sectionMaterials = (section: CustomizedImportSection) =>
  draft.value.materials.filter(
    (item) =>
      customizedMaterialSection(item.category, isCustomizedImage(assets.value[item.assetId])) ===
      section,
  );
const sectionPending = (section: CustomizedImportSection) =>
  pendingFiles.value.filter((item) => item.category === section);
const readingFile = ref<{
  name: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  contentPath: string | null;
  updatedAt: string;
} | null>(null);
let readingTrigger: HTMLElement | null = null;
const preview = (assetId: string, event: MouseEvent, returnFocus?: HTMLElement | null) => {
  const asset = assets.value[assetId];
  if (!asset || materialErrors.value[assetId]) return;
  readingTrigger = returnFocus ?? (event.currentTarget as HTMLElement);
  readingFile.value = {
    name: asset.originalFileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    isImage: isCustomizedImage(asset),
    updatedAt: asset.updatedAt,
    contentPath: `/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}/versions/${asset.currentVersion}/content`,
  };
};
const closePreview = () => {
  readingFile.value = null;
  void nextTick(() => readingTrigger?.isConnected && readingTrigger.focus());
};
const downloadDocument = (content: string, name: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
const downloadTemplate = () => {
  const anchor = document.createElement('a');
  anchor.href = CUSTOMIZED_REQUIREMENTS_TEMPLATE_URL;
  anchor.download = CUSTOMIZED_REQUIREMENTS_TEMPLATE_NAME;
  anchor.click();
};
const downloadLegacyBrief = () =>
  downloadDocument(`视频创作简报\n\n${draft.value.requirements}`, '视频创作简报-旧版文字.txt');
const sizeLabel = (size: number) =>
  size >= 1048576
    ? `${(size / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
const preventUnload = (event: BeforeUnloadEvent) => {
  if (pendingFiles.value.length || uploading.value || persistence?.dirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', preventUnload);
onBeforeUnmount(() => {
  disposed = true;
  nodeActivation.invalidate();
  clearTimeout(branchToastTimer);
  loadController?.abort();
  uploadController?.abort();
  branchController?.abort();
  if (autosaveTimer) clearTimeout(autosaveTimer);
  window.removeEventListener('beforeunload', preventUnload);
});
</script>

<template>
  <div class="customized-import-page">
    <WorkflowNavigationFeedback
      :pending-step-label="pendingStepLabel"
      :context-switching="runContextSwitching"
      :branch-toast="branchSwitchToast"
    />
    <EffectWorkflowCanvas
      v-if="!loadError && (!loading || runContextSwitching)"
      :active-step="activeStep"
      :nodes="canvasNodes"
      workflow-label="定制类"
      workflow-number="02"
      :stale-counts="staleCounts"
      @select="selectStep"
      @branches="openBranchTree"
    />
    <WorkflowEditingBanner
      v-if="temporaryEdit && activeStep === 0"
      node-label="资料包导入"
      description="修改会先保存在当前编辑副本；保存版本后才会发布，取消编辑会放弃本次修改。"
    />
    <EffectWorkflowBranchTree
      v-if="branchOpen"
      :project-name="context.currentProject.value?.name ?? '当前项目'"
      :tree="null"
      :alternate-layout="branchLayout"
      navigation-description="同一信息卡下的脚本共同属于当前工作流。点击脚本查看，进入下一节点时使用所选脚本。"
      :alternate-stages="customizedBranchStages"
      workflow-label="定制类"
      :active-workflow-run-id="branchTree?.activeWorkflowRunId"
      :loading="branchLoading"
      :error="branchError"
      :switching="branchSwitching"
      :fork-disabled="temporaryEdit"
      :active-template-id="null"
      @close="closeBranchTree"
      @retry="loadBranchTree"
      @select-workflow="selectBranch"
    />
    <WorkflowPageLoading
      v-if="loading && !runContextSwitching"
      description="加载当前项目的视频创作简报与品牌素材…"
    />
    <section v-else-if="loadError" class="page-state" role="alert">
      <AlertCircle :size="25" />
      <h3>{{ loadError }}</h3>
      <button type="button" @click="reload">重新加载</button>
    </section>
    <template v-else>
      <div v-if="actionError" class="error-banner" role="alert">
        <AlertCircle :size="17" /><span>{{ actionError }}</span
        ><button v-if="saveStatus === 'error'" type="button" @click="save">重试保存</button
        ><button v-if="saveStatus === 'error'" type="button" @click="reload">重新加载</button>
      </div>
      <section v-if="activeStep === 0" class="import-workspace-card">
        <header class="node-heading">
          <span class="node-number">01</span>
          <div>
            <h1>资料包导入</h1>
            <p>导入视频创作简报和可选的品牌素材</p>
          </div>
          <div class="heading-actions">
            <WorkflowNodeEditActions
              :editing="sourceEditing"
              :temporary="temporaryEdit"
              :disabled="busy"
              :save-disabled="saveStatus === 'saving' || !sourceReady || pendingFiles.length > 0"
              :saving="versionSaving"
              @begin="beginEdit"
              @cancel="cancelEdit"
              @save="saveVersion"
            />
            <button type="button" :disabled="busy" @click="downloadTemplate">
              <FileText :size="14" />下载简报模板
            </button>
            <span class="save-indicator" :class="saveStatus" role="status">{{
              sourceEditing ? statusLabel : '版本已保存'
            }}</span>
          </div>
        </header>
        <details v-if="draft.requirements.trim()" class="legacy-brief">
          <summary>查看旧版已保存文字</summary>
          <p>旧版文字已保留，可下载为文档，整理后通过简报区域上传。</p>
          <pre>{{ draft.requirements }}</pre>
          <button type="button" @click="downloadLegacyBrief">
            <Download :size="14" />下载旧版文字
          </button>
        </details>
        <div class="import-layout">
          <ImportSourceCard
            v-for="section in sections"
            :key="section.id"
            :title="section.title"
            :description="section.description"
            :class="{ 'visual-reference-card': section.id === 'VISUAL_REFERENCE' }"
            :aria-label="section.title"
          >
            <template #icon
              ><ImageIcon v-if="section.id === 'VISUAL_REFERENCE'" :size="20" /><FileText
                v-else
                :size="20"
            /></template>
            <ImportDropzone
              :accept="section.id === 'VISUAL_REFERENCE' ? imageAccept : documentAccept"
              :disabled="busy || !sourceEditing"
              :prompt="section.prompt"
              :hint="
                section.id === 'VISUAL_REFERENCE'
                  ? '品牌 Logo、标准字、品牌图案等；无需提供产品成品图片'
                  : '支持导入一份完整简报，也可同时上传多份补充文档'
              "
              :formats="
                section.id === 'VISUAL_REFERENCE'
                  ? 'JPG / PNG / WebP / PSD'
                  : 'Word / Excel / PDF / TXT / Markdown'
              "
              @files="chooseFiles($event, section.id)"
            />
            <div class="materials-heading">
              <strong>已导入{{ section.id === 'VISUAL_REFERENCE' ? '品牌素材' : '文档' }}</strong
              ><small
                >{{ sectionMaterials(section.id).length }} 份<span
                  v-if="sectionPending(section.id).length"
                >
                  · {{ sectionPending(section.id).length }} 份待上传</span
                ></small
              >
            </div>
            <div
              v-if="!sectionMaterials(section.id).length && !sectionPending(section.id).length"
              class="section-empty"
            >
              {{
                section.id === 'VISUAL_REFERENCE'
                  ? '暂无品牌素材，不影响简报导入'
                  : '暂无简报文档，请上传填写好的视频创作简报'
              }}
            </div>
            <div class="section-files">
              <ImportMaterialRow
                v-for="item in sectionMaterials(section.id)"
                :key="item.assetId"
                :name="assets[item.assetId]?.originalFileName || '资料引用暂不可用'"
                :description="
                  assets[item.assetId]
                    ? `${sizeLabel(assets[item.assetId]!.sizeBytes)} · 已上传`
                    : '正在恢复资料'
                "
                :error="materialErrors[item.assetId]"
              >
                <template #preview
                  ><span v-if="isCustomizedImage(assets[item.assetId])" class="material-thumbnail"
                    ><ImportImagePreview
                      :file="{
                        id: item.assetId,
                        projectId,
                        name: assets[item.assetId]!.originalFileName,
                        contentUrl: assets[item.assetId]!.contentUrl,
                        updatedAt: assets[item.assetId]!.updatedAt,
                        mimeType: assets[item.assetId]!.mimeType,
                        ready: !materialErrors[item.assetId],
                      }" /></span
                  ><span v-else class="file-extension"><FileText :size="20" /></span
                ></template>
                <template #details
                  ><EffectUpwardCreatableSelect
                    v-if="section.id === 'VISUAL_REFERENCE'"
                    :field-label="`${assets[item.assetId]?.originalFileName || '图片'}用途`"
                    :model-value="item.imageUsage ?? ''"
                    :options="customizedImageUsageOptions(item.imageUsage)"
                    :creatable="false"
                    :disabled="busy || !sourceEditing"
                    @update:model-value="
                      item.imageUsage = $event ? ($event as CustomizedImageUsage) : undefined
                    "
                /></template>
                <template #actions
                  ><button
                    type="button"
                    class="file-read"
                    :disabled="!!materialErrors[item.assetId]"
                    @click="preview(item.assetId, $event)"
                  >
                    <FileText :size="13" />查看内容</button
                  ><a
                    v-if="assets[item.assetId] && !materialErrors[item.assetId]"
                    :href="assets[item.assetId]!.downloadUrl"
                    :aria-label="`下载 ${assets[item.assetId]!.originalFileName}`"
                    ><Download :size="13" /></a
                  ><button
                    type="button"
                    class="file-delete"
                    :disabled="busy || !sourceEditing"
                    :aria-label="`移除 ${assets[item.assetId]?.originalFileName || '资料引用'}`"
                    @click="removeMaterial(item.assetId)"
                  >
                    <Trash2 :size="13" /></button
                ></template>
              </ImportMaterialRow>
              <ImportMaterialRow
                v-for="item in sectionPending(section.id)"
                :key="item.id"
                :name="item.file.name"
                :description="`${sizeLabel(item.file.size)} · ${uploading ? '上传中' : '待上传'}`"
                :error="item.error"
                ><template #preview
                  ><span class="file-extension"><FileText :size="20" /></span></template
                ><template #actions
                  ><LoaderCircle v-if="uploading" class="spin" :size="14" /><button
                    v-else
                    type="button"
                    :disabled="busy || !sourceEditing"
                    @click="storeFiles"
                  >
                    重试上传</button
                  ><button
                    type="button"
                    class="file-delete"
                    :disabled="busy || !sourceEditing"
                    :aria-label="`移除 ${item.file.name}`"
                    @click="
                      pendingFiles = pendingFiles.filter((candidate) => candidate.id !== item.id)
                    "
                  >
                    <Trash2 :size="13" /></button></template
              ></ImportMaterialRow>
            </div>
          </ImportSourceCard>
        </div>
        <p v-if="notice" class="source-notice" role="status">{{ notice }}</p>
        <WorkflowNodeFooter
          :show-validate="false"
          next-label="下一步：信息提炼"
          :next-disabled="busy || sourceEditing || !confirmedSteps.includes(0)"
          @next="next"
        />
      </section>
      <CustomizedInfoExtractionNodePage
        v-else-if="activeStep === 1"
        ref="extractionWorkspace"
        :key="`${projectId}:${workflowRunId}`"
        :project-id="projectId"
        :workflow-run-id="workflowRunId"
        :source-confirmed="extractionSourceConfirmed"
        :sources="extractionSources"
        @back="selectStep(0)"
        @next="selectStep(2)"
        @workflow-run-change="load({ preserveView: true })"
        @view-source="preview"
      />
      <CustomizedStoryboardWorkspace
        v-else-if="activeStep === 2"
        ref="storyboardWorkspace"
        :key="`${projectId}:${workflowRunId}`"
        :project-id="projectId"
        :workflow-run-id="workflowRunId"
        :brief-confirmed="confirmedSteps.includes(1)"
        :scope-readonly="Boolean(activeRun?.isTemporaryBranch)"
        :viewed-run-id="storyboardViewedRunId"
        @back="selectStep(1)"
        @viewing="storyboardViewedRunId = $event"
        @next="selectBranch({ workflowRunId: $event, nodeId: 'SHOT_PROMPT' })"
        @published="loadBranchTree()"
        @deleted="onStoryboardDeleted"
      />
      <CustomizedProductionWorkspace
        v-else-if="activeStep === 3 || activeStep === 4"
        ref="productionWorkspace"
        :key="`${projectId}:${workflowRunId}:${activeStep}`"
        :project-id="projectId"
        :workflow-run-id="workflowRunId"
        :mode="activeStep === 3 ? 'ASSETS' : 'SHOTS'"
        @back="selectStep(activeStep - 1)"
        @next="selectStep(activeStep + 1)"
        @saved="loadBranchTree()"
        @published="load()"
      />
      <section v-else class="import-workspace-card next-node">
        <header class="node-heading">
          <span class="node-number">{{ String(activeStep + 1).padStart(2, '0') }}</span>
          <div>
            <h1>{{ currentNode.title }}</h1>
            <p>{{ currentNode.description }}</p>
          </div>
        </header>
        <div class="page-state">
          <h3>{{ currentNode.title }}待接入</h3>
          <p>可返回资料导入继续整理创作简报和附件，已保存资料会保留在当前项目。</p>
          <small>该节点尚未开始生成</small>
        </div>
        <WorkflowNodeFooter
          back-label="返回资料导入"
          :show-validate="false"
          :show-next="false"
          next-label=""
          @back="selectStep(0)"
        />
      </section>
      <ImportContentViewer v-if="readingFile" :file="readingFile" @close="closePreview" />
    </template>
  </div>
</template>

<style scoped>
.customized-import-page {
  margin: 18px;
  padding: 26px 28px 30px;
  color: #17233a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 26px;
  box-shadow: 0 12px 34px #7a4e3b12;
}
.import-workspace-card {
  padding: 22px;
  background: #fff;
  border: 1px solid #e2e9f4;
  border-radius: 20px;
  box-shadow: 0 8px 25px #7a4e3b0c;
}
.node-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 22px;
}
.node-number {
  display: grid;
  flex: 0 0 42px;
  height: 42px;
  place-items: center;
  color: #0891a9;
  background: #edfafc;
  border-radius: 13px;
  font-size: 14px;
  font-weight: 800;
}
h1,
h3,
p {
  margin: 0;
}
h1 {
  font-size: 18px;
  line-height: 1.5;
}
.node-heading p,
.panel-heading p {
  margin-top: 3px;
  color: #8491a6;
  font-size: 11px;
  line-height: 1.6;
}
.heading-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}
button,
a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #41516a;
  background: #fff;
  border: 1px solid #d3ddea;
  border-radius: 8px;
  padding: 8px 11px;
  text-decoration: none;
  font-size: 11px;
  font-weight: 700;
}
button:hover,
a:hover {
  border-color: #93b4ff;
  background: #f8fbff;
}
button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
button:focus-visible,
a:focus-visible,
input:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
.save-indicator {
  color: #94a3b8;
  font-size: 10px;
  white-space: nowrap;
}
.save-indicator.saved {
  color: #1e9678;
}
.save-indicator.error {
  color: #c2413b;
}
.import-layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 18px;
}

.legacy-brief {
  margin-bottom: 18px;
  padding: 14px;
  color: #66789c;
  background: #f8fbff;
  border: 1px solid #e4eaf3;
  border-radius: 12px;
  font-size: 12px;
}
.source-notice {
  margin: 14px 0;
  color: #66789c;
  font-size: 12px;
}
.legacy-brief summary {
  cursor: pointer;
}
.legacy-brief pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.7;
}
.materials-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 18px 0 10px;
  font-size: 12px;
}
.materials-heading small,
.section-empty {
  color: #94a3b8;
  font-size: 11px;
}
.section-empty {
  padding: 15px;
  text-align: center;
  border: 1px dashed #e4eaf3;
  border-radius: 12px;
}
.visual-reference-card .section-files {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px 14px;
}
.section-files :deep(.file-copy > div) {
  margin-top: 6px;
  max-width: 160px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1200px) {
  .import-layout {
    gap: 14px;
  }
  .node-heading {
    flex-wrap: wrap;
  }
  .heading-actions {
    margin-left: auto;
  }
}
@media (max-width: 1000px) {
  .import-layout {
    grid-template-columns: 1fr;
  }
  .source-card {
    padding: 17px;
  }
  .heading-actions {
    width: 100%;
    justify-content: flex-start;
    margin-left: 54px;
  }
}
@media (max-width: 680px) {
  .customized-import-page {
    margin: 8px;
    padding: 14px;
    border-radius: 20px;
  }
  .import-workspace-card {
    padding: 14px;
    border-radius: 16px;
  }
  .heading-actions {
    margin-left: 0;
  }
  .source-card {
    padding: 12px;
  }
}
</style>
