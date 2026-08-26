import type { EffectImportProduct, EffectVideoConfig } from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
} from '@ai-marketing/contracts';

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

const workspaces = new Map<string, EffectSegmentRenderWorkspace>();

const narratives = [
  '痛点前置型',
  '效果展示型',
  '场景代入型',
  '科普讲解型',
  '对比测评型',
  '开箱体验型',
];
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
  tasks: workspace.tasks.map((task) => ({ ...task, materialTags: [...task.materialTags] })),
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
  config: EffectVideoConfig,
  index: number,
): EffectSegmentRenderTask => {
  const sequence = index + 1;
  const fragmentType = EFFECT_PROMPT_FRAGMENT_TYPES[index % EFFECT_PROMPT_FRAGMENT_TYPES.length]!;
  const narrative = narratives[index % narratives.length]!;
  const scene = scenes[(index * 5) % scenes.length]!;
  const persona = personas[(index * 3) % personas.length]!;
  const sellingPoint = sellingPoints[(index * 7) % sellingPoints.length]!;
  const camera = cameras[(index * 11) % cameras.length]!;
  const emotion = emotions[(index * 13) % emotions.length]!;
  const promptCode = `P${pad(sequence)}-${stableSuffix(`${product.id}:${sequence}`)}`;
  const durationSeconds = Math.min(10, Math.max(3, Math.round(config.durationSeconds / 3)));
  const initialRunning = sequence > 47;
  const progressBySequence: Record<number, number> = { 48: 76, 49: 52, 50: 29 };
  const now = new Date().toISOString();
  return {
    id: `render-${product.id}-${pad(sequence)}`,
    renderCode: `R-${pad(sequence)}`,
    productId: product.id,
    productName: safeProductName(product),
    promptId: `prompt-${product.id}-${pad(sequence)}`,
    promptCode,
    promptText: `${durationSeconds} 秒独立${EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[fragmentType]}。在${scene}由${persona}完成一个清晰可见的动作，采用${camera}，只突出“${sellingPoint}”，整体情绪${emotion}。保持${config.aspectRatio}画幅与${config.styleTone}风格，不生成完整成片时间线。`,
    fragmentType,
    materialTags: [narrative, scene, emotion],
    durationSeconds,
    modelMatch: 'AUTO_MATCHED',
    source: 'PROMPT',
    sourceName: promptCode,
    status: initialRunning ? 'RENDERING' : 'COMPLETED',
    progress: initialRunning ? progressBySequence[sequence]! : 100,
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
  config: EffectVideoConfig,
): EffectSegmentRenderWorkspace => ({
  ...context,
  productId: product.id,
  tasks: Array.from({ length: 50 }, (_, index) => createPromptTask(product, config, index)),
  updatedAt: new Date().toISOString(),
});

const getMutableWorkspace = (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  config: EffectVideoConfig,
): EffectSegmentRenderWorkspace => {
  const key = workspaceKey(context, product.id);
  const existing = workspaces.get(key);
  if (existing) return existing;
  const created = createWorkspace(context, product, config);
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
  return snapshot;
};

export const loadEffectSegmentRenderWorkspace = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  config: EffectVideoConfig,
  signal?: AbortSignal,
): Promise<EffectSegmentRenderWorkspace> => {
  await wait(120, signal);
  return cloneWorkspace(getMutableWorkspace(context, product, config));
};

export const startEffectSegmentRenderBatch = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  config: EffectVideoConfig,
  options: EffectSegmentRenderOperationOptions = {},
): Promise<EffectSegmentRenderWorkspace> => {
  const workspace = getMutableWorkspace(context, product, config);
  const promptTasks = workspace.tasks.filter((task) => task.source === 'PROMPT');
  const stepDelayMs = options.stepDelayMs ?? 110;
  for (const task of promptTasks) {
    task.status = 'QUEUED';
    task.progress = 0;
    task.retryCount = 0;
    task.abnormal = false;
    task.errorMessage = null;
  }
  publish(workspace, options.onUpdate);
  await wait(stepDelayMs, options.signal);

  for (const task of promptTasks) {
    task.status = 'RENDERING';
    task.progress = 18;
  }
  publish(workspace, options.onUpdate);
  await wait(stepDelayMs, options.signal);

  for (const task of promptTasks) task.progress = 54;
  const retryCandidates = [promptTasks[16], promptTasks[33], promptTasks.at(-1)].filter(
    (task): task is EffectSegmentRenderTask => Boolean(task),
  );
  for (const task of retryCandidates) {
    task.status = 'AUTO_RETRY';
    task.progress = 38;
    task.retryCount = 1;
    task.errorMessage = '生成服务暂时繁忙，正在自动重试';
  }
  publish(workspace, options.onUpdate);
  await wait(stepDelayMs, options.signal);

  for (const task of promptTasks) {
    task.status = 'RENDERING';
    task.progress = 82;
    task.errorMessage = null;
  }
  const finalFailure = promptTasks.at(-1);
  if (finalFailure) {
    finalFailure.status = 'AUTO_RETRY';
    finalFailure.progress = 63;
    finalFailure.retryCount = 2;
    finalFailure.errorMessage = '第二次自动重试仍未完成';
  }
  publish(workspace, options.onUpdate);
  await wait(stepDelayMs, options.signal);

  for (const task of promptTasks) {
    task.status = 'COMPLETED';
    task.progress = 100;
    task.abnormal = false;
    task.errorMessage = null;
    task.updatedAt = new Date().toISOString();
  }
  if (finalFailure) {
    finalFailure.status = 'FAILED';
    finalFailure.progress = 63;
    finalFailure.abnormal = true;
    finalFailure.errorMessage = '自动重试已达上限，请人工单条重生成';
  }
  return publish(workspace, options.onUpdate);
};

export const regenerateEffectSegmentRenderTasks = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  config: EffectVideoConfig,
  taskIds: readonly string[],
  options: EffectSegmentRenderOperationOptions = {},
): Promise<EffectSegmentRenderWorkspace> => {
  const workspace = getMutableWorkspace(context, product, config);
  const selected = workspace.tasks.filter((task) => taskIds.includes(task.id));
  const stepDelayMs = options.stepDelayMs ?? 90;
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
  return cloneWorkspace(workspace);
};

export const deleteEffectSegmentRenderTasks = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  config: EffectVideoConfig,
  taskIds: readonly string[],
  signal?: AbortSignal,
): Promise<EffectSegmentRenderWorkspace> => {
  await wait(80, signal);
  const workspace = getMutableWorkspace(context, product, config);
  workspace.tasks = workspace.tasks.filter((task) => !taskIds.includes(task.id));
  return publish(workspace);
};

export const importEffectSegmentRenderFiles = async (
  context: EffectSegmentRenderContext,
  product: EffectImportProduct,
  config: EffectVideoConfig,
  files: readonly EffectSegmentRenderImportedFile[],
  signal?: AbortSignal,
): Promise<EffectSegmentRenderWorkspace> => {
  await wait(100, signal);
  const workspace = getMutableWorkspace(context, product, config);
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
      materialTags: ['外部导入', file.type.startsWith('video/') ? '视频素材' : '补充素材'],
      durationSeconds: Math.min(10, Math.max(3, Math.round(config.durationSeconds / 3))),
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
      materialTags: task.materialTags,
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

export const clearEffectSegmentRenderMockWorkspaces = (): void => workspaces.clear();
