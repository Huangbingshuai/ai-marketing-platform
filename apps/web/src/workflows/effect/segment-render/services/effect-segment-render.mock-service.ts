import type {
  EffectImportProduct,
  EffectSegmentRenderSettings,
  EffectVideoConfig,
} from '@ai-marketing/contracts';
import { EFFECT_PROMPT_FRAGMENT_TYPES } from '@ai-marketing/contracts';

import type {
  EffectSegmentRenderTask,
  EffectSegmentRenderWorkspace,
} from '../effect-segment-render-state';

export type EffectSegmentRenderContext = {
  projectId: string;
  workflowRunId: string;
};

export type EffectSegmentRenderOperationOptions = {
  signal?: AbortSignal;
  stepDelayMs?: number;
  onUpdate?: (workspace: EffectSegmentRenderWorkspace) => void;
};

export type EffectSegmentRenderImportedFile = {
  name: string;
  size: number;
  type: string;
};

type LegacyCompatibleRenderSettings = EffectSegmentRenderSettings | EffectVideoConfig;

const workspaces = new Map<string, EffectSegmentRenderWorkspace>();
const activeJobs = new Map<string, Promise<void>>();
const workspaceListeners = new Map<
  string,
  Set<(workspace: EffectSegmentRenderWorkspace) => void>
>();

const scenes = [
  '周末家庭厨房',
  '现代公寓开放厨房',
  '年货市集摊位',
  '户外露营饭桌',
  '午休办公室茶水间',
  '岭南骑楼早餐店',
];
const personas = ['年轻上班族', '三口之家主理人', '专业测评人', '户外露营爱好者', '年货采购者'];
const sellingPoints = ['产品纹理清晰可见', '使用动作简单直接', '核心卖点单点呈现', '产品稳定露出'];
const cameras = ['固定机位三段跳切', '广角慢推近景', '手持跟拍特写', '俯拍全景微距切面'];
const emotions = ['专业严谨', '活力明快', '温馨治愈', '节庆热闹', '干货科普', '焦虑唤醒'];

const workspaceKey = (context: EffectSegmentRenderContext, productId: string): string =>
  `${context.projectId}:${context.workflowRunId}:${productId}`;

const cloneWorkspace = (workspace: EffectSegmentRenderWorkspace): EffectSegmentRenderWorkspace => ({
  ...workspace,
  tasks: workspace.tasks.map((task) => ({ ...task })),
});

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

const ensureNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

const wait = async (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  ensureNotAborted(signal);
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
};

const pad = (value: number): string => String(value).padStart(3, '0');

const stableSuffix = (value: string): string => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0)
    .toString(36)
    .slice(0, 3)
    .toUpperCase()
    .padEnd(3, 'X');
};

const safeProductName = (product: EffectImportProduct): string =>
  product.name.trim() || '未命名产品';

const createPromptTask = (
  product: EffectImportProduct,
  _settings: LegacyCompatibleRenderSettings,
  index: number,
): EffectSegmentRenderTask => {
  const sequence = index + 1;
  const fragmentType = EFFECT_PROMPT_FRAGMENT_TYPES[index % EFFECT_PROMPT_FRAGMENT_TYPES.length]!;
  const scene = scenes[(index * 5) % scenes.length]!;
  const persona = personas[(index * 3) % personas.length]!;
  const sellingPoint = sellingPoints[(index * 7) % sellingPoints.length]!;
  const camera = cameras[(index * 11) % cameras.length]!;
  const emotion = emotions[(index * 13) % emotions.length]!;
  const promptCode = `P${pad(sequence)}-${stableSuffix(`${product.id}:${sequence}`)}`;
  const durationSeconds = 5;
  const now = new Date().toISOString();
  return {
    id: `render-${product.id}-${pad(sequence)}`,
    renderCode: `R-${pad(sequence)}`,
    productId: product.id,
    productName: safeProductName(product),
    promptId: `prompt-${product.id}-${pad(sequence)}`,
    promptCode,
    promptText: `在${scene}由${persona}完成一个清晰可见的动作，采用${camera}，只突出“${sellingPoint}”，整体情绪${emotion}，不生成完整成片时间线。`,
    fragmentType,
    durationSeconds,
    modelMatch: 'AUTO_MATCHED',
    source: 'PROMPT',
    sourceName: promptCode,
    status: 'QUEUED',
    progress: 0,
    retryCount: 0,
    maxAutoRetries: 2,
    abnormal: false,
    errorMessage: null,
    updatedAt: now,
  };
};

const createWorkspace = (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  _settings: LegacyCompatibleRenderSettings,
): EffectSegmentRenderWorkspace => {
  void _settings;
  return {
    ...context,
    productId: product.id,
    promptCount: 50,
    batchStatus: 'NOT_STARTED',
    tasks: [],
    startedAt: null,
    completedAt: null,
    updatedAt: new Date().toISOString(),
  };
};

const getMutableWorkspace = (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  settings: LegacyCompatibleRenderSettings,
): EffectSegmentRenderWorkspace => {
  const key = workspaceKey(context, product.id);
  const existing = workspaces.get(key);
  if (existing) return existing;
  const created = createWorkspace(context, product, settings);
  workspaces.set(key, created);
  return created;
};

const publish = (
  workspace: EffectSegmentRenderWorkspace,
  onUpdate?: EffectSegmentRenderOperationOptions['onUpdate'],
): EffectSegmentRenderWorkspace => {
  workspace.updatedAt = new Date().toISOString();
  const snapshot = cloneWorkspace(workspace);
  onUpdate?.(snapshot);
  const key = workspaceKey(workspace, workspace.productId);
  for (const listener of workspaceListeners.get(key) ?? []) listener(cloneWorkspace(snapshot));
  return snapshot;
};

export const subscribeEffectSegmentRenderWorkspace = (
  context: EffectSegmentRenderContext,
  productId: string,
  listener: (workspace: EffectSegmentRenderWorkspace) => void,
): (() => void) => {
  const key = workspaceKey(context, productId);
  const listeners = workspaceListeners.get(key) ?? new Set();
  listeners.add(listener);
  workspaceListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) workspaceListeners.delete(key);
  };
};

export const loadEffectSegmentRenderWorkspace = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  settings: LegacyCompatibleRenderSettings,
  signal?: AbortSignal,
): Promise<EffectSegmentRenderWorkspace> => {
  await wait(120, signal);
  return cloneWorkspace(getMutableWorkspace(context, product, settings));
};

const runMockBatch = async (
  workspace: EffectSegmentRenderWorkspace,
  stepDelayMs: number,
  onUpdate?: EffectSegmentRenderOperationOptions['onUpdate'],
): Promise<void> => {
  const promptTasks = workspace.tasks.filter((task) => task.source === 'PROMPT');

  await wait(stepDelayMs);
  workspace.batchStatus = 'RUNNING';
  promptTasks.forEach((task, index) => {
    if (index >= 12) return;
    task.status = 'RENDERING';
    task.progress = 18;
  });
  publish(workspace, onUpdate);

  await wait(stepDelayMs);
  promptTasks.forEach((task, index) => {
    task.status = index < 24 ? 'COMPLETED' : index < 42 ? 'RENDERING' : 'QUEUED';
    task.progress = index < 24 ? 100 : index < 42 ? 54 : 0;
    task.errorMessage = null;
  });
  for (const task of [promptTasks[16], promptTasks[33]]) {
    if (!task) continue;
    task.status = 'AUTO_RETRY';
    task.progress = 38;
    task.retryCount = 1;
    task.errorMessage = '生成服务暂时繁忙，正在自动重试';
  }
  publish(workspace, onUpdate);

  await wait(stepDelayMs);
  promptTasks.forEach((task, index) => {
    task.status = index < 42 ? 'COMPLETED' : 'RENDERING';
    task.progress = index < 42 ? 100 : 82;
    task.errorMessage = null;
  });
  const finalFailure = promptTasks.at(-1);
  if (finalFailure) {
    finalFailure.status = 'AUTO_RETRY';
    finalFailure.progress = 63;
    finalFailure.retryCount = 2;
    finalFailure.errorMessage = '第二次自动重试仍未完成';
  }
  publish(workspace, onUpdate);

  await wait(stepDelayMs);
  const completedAt = new Date().toISOString();
  for (const task of promptTasks) {
    task.status = 'COMPLETED';
    task.progress = 100;
    task.abnormal = false;
    task.errorMessage = null;
    task.updatedAt = completedAt;
  }
  if (finalFailure) {
    finalFailure.status = 'FAILED';
    finalFailure.progress = 63;
    finalFailure.abnormal = true;
    finalFailure.errorMessage = '自动重试已达上限，请人工单条重生成';
  }
  workspace.batchStatus = finalFailure ? 'PARTIAL' : 'COMPLETED';
  workspace.completedAt = completedAt;
  publish(workspace, onUpdate);
};

export const startEffectSegmentRenderBatch = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  settings: LegacyCompatibleRenderSettings,
  options: EffectSegmentRenderOperationOptions = {},
): Promise<EffectSegmentRenderWorkspace> => {
  const workspace = getMutableWorkspace(context, product, settings);
  const key = workspaceKey(context, product.id);
  ensureNotAborted(options.signal);
  if (
    activeJobs.has(key) ||
    workspace.batchStatus === 'QUEUED' ||
    workspace.batchStatus === 'RUNNING'
  )
    throw new Error('当前商品已有进行中的视频渲染批次');

  const importedTasks = workspace.tasks.filter((task) => task.source === 'IMPORTED');
  const now = new Date().toISOString();
  workspace.tasks = [
    ...importedTasks,
    ...Array.from({ length: workspace.promptCount }, (_, index) =>
      createPromptTask(product, settings, index),
    ),
  ];
  workspace.batchStatus = 'QUEUED';
  workspace.startedAt = now;
  workspace.completedAt = null;
  publish(workspace, options.onUpdate);

  const stepDelayMs = options.stepDelayMs ?? 520;
  const job = runMockBatch(workspace, stepDelayMs, options.onUpdate).finally(() => {
    if (activeJobs.get(key) === job) activeJobs.delete(key);
  });
  activeJobs.set(key, job);

  if (stepDelayMs === 0) await job;
  else await wait(Math.min(80, Math.max(1, Math.floor(stepDelayMs / 4))), options.signal);
  return cloneWorkspace(workspace);
};

export const waitForEffectSegmentRenderMockBatch = async (
  context: EffectSegmentRenderContext,
  productId: string,
): Promise<void> => {
  await activeJobs.get(workspaceKey(context, productId));
};

export const regenerateEffectSegmentRenderTasks = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  settings: LegacyCompatibleRenderSettings,
  taskIds: readonly string[],
  options: EffectSegmentRenderOperationOptions = {},
): Promise<EffectSegmentRenderWorkspace> => {
  const workspace = getMutableWorkspace(context, product, settings);
  const selected = workspace.tasks.filter(
    (task) =>
      task.source === 'PROMPT' &&
      taskIds.includes(task.id) &&
      task.status !== 'AUTO_RETRY' &&
      task.status !== 'QUEUED' &&
      task.status !== 'RENDERING',
  );
  if (!selected.length) throw new Error('没有可重新生成的视频片段');
  const stepDelayMs = options.stepDelayMs ?? 90;
  workspace.batchStatus = 'RUNNING';
  workspace.completedAt = null;
  for (const task of selected) {
    task.status = 'RENDERING';
    task.progress = 8;
    task.abnormal = false;
    task.errorMessage = null;
  }
  publish(workspace, options.onUpdate);
  for (const progress of [42, 76, 100]) {
    await wait(stepDelayMs, options.signal);
    for (const task of selected) {
      task.progress = progress;
      task.status = progress === 100 ? 'COMPLETED' : 'RENDERING';
      task.updatedAt = new Date().toISOString();
    }
    publish(workspace, options.onUpdate);
  }
  const promptTasks = workspace.tasks.filter((task) => task.source === 'PROMPT');
  workspace.batchStatus =
    promptTasks.length === workspace.promptCount &&
    promptTasks.every((task) => task.status === 'COMPLETED')
      ? 'COMPLETED'
      : 'PARTIAL';
  workspace.completedAt = workspace.batchStatus === 'COMPLETED' ? new Date().toISOString() : null;
  publish(workspace, options.onUpdate);
  return cloneWorkspace(workspace);
};

export const deleteEffectSegmentRenderTasks = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  settings: LegacyCompatibleRenderSettings,
  taskIds: readonly string[],
  signal?: AbortSignal,
): Promise<EffectSegmentRenderWorkspace> => {
  await wait(80, signal);
  const workspace = getMutableWorkspace(context, product, settings);
  workspace.tasks = workspace.tasks.filter((task) => !taskIds.includes(task.id));
  if (
    workspace.batchStatus !== 'NOT_STARTED' &&
    workspace.tasks.filter((task) => task.source === 'PROMPT').length < workspace.promptCount
  ) {
    workspace.batchStatus = 'PARTIAL';
    workspace.completedAt = null;
  }
  return publish(workspace);
};

export const importEffectSegmentRenderFiles = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  settings: LegacyCompatibleRenderSettings,
  files: readonly EffectSegmentRenderImportedFile[],
  signal?: AbortSignal,
): Promise<EffectSegmentRenderWorkspace> => {
  await wait(100, signal);
  const workspace = getMutableWorkspace(context, product, settings);
  const existingImported = workspace.tasks.filter((task) => task.source === 'IMPORTED').length;
  const now = new Date().toISOString();
  const imported = files.map<EffectSegmentRenderTask>((file, index) => {
    const sequence = existingImported + index + 1;
    return {
      id: `import-${product.id}-${pad(sequence)}-${stableSuffix(file.name)}`,
      renderCode: `IMP-${pad(sequence)}`,
      productId: product.id,
      productName: safeProductName(product),
      promptId: null,
      promptCode: null,
      promptText: '外部导入素材不包含来源 Prompt。',
      fragmentType: 'PRODUCT_DISPLAY',
      durationSeconds: 5,
      modelMatch: 'AUTO_MATCHED',
      source: 'IMPORTED',
      sourceName: file.name,
      status: 'IMPORTED',
      progress: 100,
      retryCount: 0,
      maxAutoRetries: 0,
      abnormal: false,
      errorMessage: null,
      updatedAt: now,
    };
  });
  workspace.tasks.unshift(...imported);
  return publish(workspace);
};

export const exportEffectSegmentRenderTasks = (
  product: EffectImportProduct,
  tasks: readonly EffectSegmentRenderTask[],
): { blob: Blob; fileName: string } => {
  const payload = {
    schemaVersion: 1,
    productId: product.id,
    productName: safeProductName(product),
    exportedAt: new Date().toISOString(),
    taskCount: tasks.length,
    tasks: tasks.map((task) => ({
      renderCode: task.renderCode,
      promptCode: task.promptCode,
      fragmentType: task.fragmentType,
      durationSeconds: task.durationSeconds,
      status: task.status,
      source: task.source,
    })),
  };
  return {
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
    fileName: `${safeProductName(product)}-AI视频片段-${tasks.length}条.json`,
  };
};

export const clearEffectSegmentRenderMockWorkspaces = (): void => {
  workspaces.clear();
  activeJobs.clear();
  workspaceListeners.clear();
};
