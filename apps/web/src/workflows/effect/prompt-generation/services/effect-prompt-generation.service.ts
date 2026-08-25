import type { EffectImportProduct, EffectVideoConfig } from '@ai-marketing/contracts';

import {
  clonePromptItem,
  clonePromptWorkspace,
  EFFECT_PROMPT_LIMITS,
  normalizePromptSettings,
  type EffectPromptBatchSettings,
  type EffectPromptDimension,
  type EffectPromptItem,
  type EffectPromptMetrics,
  type EffectPromptWorkspace,
} from '../effect-prompt-generation-state';

export type EffectPromptContext = {
  projectId: string;
  workflowRunId: string;
  productId: string;
};

type PromptProduct = Pick<
  EffectImportProduct,
  'category' | 'effectiveConfig' | 'id' | 'name' | 'sku'
>;

type StorageLike = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

export type PromptMockOptions = {
  delayMs?: number;
  storage?: StorageLike | null;
};

const NARRATIVES = [
  '痛点前置型',
  '效果展示型',
  '场景代入型',
  '科普讲解型',
  '对比测评型',
  '开箱体验型',
];
const SCENES = [
  '周末家庭厨房',
  '城市露营地',
  '通勤办公室',
  '品牌线下门店',
  '明亮实验室',
  '生活化餐桌',
];
const PERSONAS = [
  '下班回家的广东程序员',
  '讲究食材的都市白领',
  '精打细算的新手妈妈',
  '户外露营的年轻情侣',
  '严谨专业的美食测评人',
  '热情爽朗的门店主理人',
];
const CAMERA_STYLES = [
  '固定机位＋三段跳切',
  '广角环绕＋慢推近景',
  '手持跟拍＋蒸汽特写',
  '俯拍全景＋微距切面',
  '低机位推进＋快速蒙太奇',
  '对称构图＋平稳横移',
];
const EMOTIONS = ['专业严谨', '活力明快', '温馨治愈', '焦虑唤醒', '干货科普'];
const FRAGMENT_TYPES = ['钩子片段', '产品展示片段', '场景种草片段', '口碑测评片段'];
const SELLING_POINT_TEMPLATES = [
  '肥瘦黄金比例',
  '广府糖酒工艺',
  '真空锁鲜',
  '咸甜酒香回甘',
  '便捷烹饪',
  '送礼体面',
];

const storageKey = (context: EffectPromptContext): string =>
  ['effect-prompt-v1', context.projectId, context.workflowRunId, context.productId]
    .map(encodeURIComponent)
    .join(':');

const availableStorage = (options?: PromptMockOptions): StorageLike | null => {
  if (options && 'storage' in options) return options.storage ?? null;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const abortError = (): Error => {
  const error = new Error('Prompt Mock operation aborted');
  error.name = 'AbortError';
  return error;
};

const waitForMock = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortError());
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
};

const hashText = (value: string): number => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const suffixFor = (seed: number): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return [0, 1, 2].map((offset) => alphabet[(seed + offset * 7) % alphabet.length]).join('');
};

const valueAt = <T>(values: readonly T[], index: number, shift = 0): T =>
  values[(index + shift) % values.length]!;

const dimensionsFor = (
  index: number,
  product: PromptProduct,
  sellingPointShift: number,
): EffectPromptDimension[] => [
  { key: 'narrative', label: '叙事结构', value: valueAt(NARRATIVES, index) },
  { key: 'scene', label: '场景变量', value: valueAt(SCENES, index, 1) },
  { key: 'persona', label: '人物变量', value: valueAt(PERSONAS, index, 2) },
  {
    key: 'sellingPoint',
    label: '卖点侧重',
    value: valueAt(SELLING_POINT_TEMPLATES, index, sellingPointShift),
  },
  { key: 'camera', label: '镜头语言', value: valueAt(CAMERA_STYLES, index, 3) },
  { key: 'emotion', label: '情绪基调', value: valueAt(EMOTIONS, index, 4) },
];

const promptContent = (
  product: PromptProduct,
  config: EffectVideoConfig,
  settings: EffectPromptBatchSettings,
  dimensions: EffectPromptDimension[],
): string => {
  const dimension = (key: EffectPromptDimension['key']): string =>
    dimensions.find((item) => item.key === key)?.value ?? '';
  const productName = product.name.trim() || '当前商品';
  const category = product.category.trim() || '产品';
  const disabled = config.disabledElements.length
    ? config.disabledElements.join('、')
    : '未成年人、绝对化文案、夸张功效';
  return [
    `【视频参数】${settings.durationSeconds}秒 · ${config.aspectRatio} · 渠道：${config.deliveryChannel} · 统一风格：${config.styleTone}`,
    `【内容结构】采用${dimension('narrative')}结构，前 1.5 秒用紧凑节奏建立观看动机。`,
    `【场景与出镜】拍摄于${dimension('scene')}，由${dimension('persona')}出镜演绎，画面保持真实使用质感。`,
    `【核心卖点】围绕“${dimension('sellingPoint')}”突出${productName}的${category}特征，避免堆叠多个卖点。`,
    `【镜头语言】使用${dimension('camera')}，整体情绪${dimension('emotion')}，关键帧包含产品三次稳定露出。`,
    `【文案口播】在${settings.durationSeconds}秒内完整传达一个行动号召，语言自然、停顿清晰、结尾强化关注或下单引导。`,
    `【音效与字幕】BGM 跟随画面节奏轻快律动，字幕逐句同步并保持高对比可读性。`,
    `【合规注意】全程禁用：${disabled}；不虚构功效，不出现未授权人物或标识。`,
  ].join('\n');
};

const buildPromptItem = (
  index: number,
  product: PromptProduct,
  config: EffectVideoConfig,
  settings: EffectPromptBatchSettings,
  generationSeed = 0,
): EffectPromptItem => {
  const stableSeed = hashText(`${product.id}:${index}:${generationSeed}`);
  const dimensions = dimensionsFor(index + generationSeed, product, stableSeed % 6);
  const now = new Date().toISOString();
  const sequence = String(index + 1).padStart(3, '0');
  return {
    id: `${product.id}-prompt-${sequence}-${generationSeed}`,
    code: `P${sequence}-${suffixFor(stableSeed)}`,
    fragmentType: valueAt(FRAGMENT_TYPES, index, generationSeed),
    dimensions,
    content: promptContent(product, config, settings, dimensions),
    semanticSimilarity: Math.min(
      settings.semanticLimit - 0.2,
      11.8,
      Number((7.1 + ((index * 13 + generationSeed) % 48) / 10).toFixed(1)),
    ),
    visualSimilarity: Math.min(
      settings.visualLimit - 0.2,
      16.4,
      Number((11.7 + ((index * 17 + generationSeed) % 49) / 10).toFixed(1)),
    ),
    createdAt: now,
    updatedAt: now,
  };
};

const metricsFor = (items: EffectPromptItem[], removedDuplicates: number): EffectPromptMetrics => ({
  generatedCount: items.length,
  removedDuplicates,
  semanticSimilarity: items.length ? Math.max(...items.map((item) => item.semanticSimilarity)) : 0,
  visualSimilarity: items.length ? Math.max(...items.map((item) => item.visualSimilarity)) : 0,
});

const createWorkspace = (
  product: PromptProduct,
  config: EffectVideoConfig,
  settings: EffectPromptBatchSettings,
  generationSeed = 0,
  hasGenerated = false,
): EffectPromptWorkspace => {
  const normalized = normalizePromptSettings(settings);
  const items = Array.from({ length: normalized.count }, (_, index) =>
    buildPromptItem(index, product, config, normalized, generationSeed),
  );
  const removedDuplicates = Math.max(1, Math.ceil(normalized.count * 0.16));
  return {
    version: 1,
    hasGenerated,
    settings: normalized,
    items,
    metrics: metricsFor(items, removedDuplicates),
    updatedAt: new Date().toISOString(),
  };
};

const parseWorkspace = (value: string | null): EffectPromptWorkspace | null => {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<EffectPromptWorkspace>;
    if (
      candidate.version !== 1 ||
      !candidate.settings ||
      !Array.isArray(candidate.items) ||
      !candidate.metrics ||
      typeof candidate.updatedAt !== 'string'
    )
      return null;
    if (
      candidate.items.some(
        (item) =>
          !item ||
          typeof item.id !== 'string' ||
          typeof item.content !== 'string' ||
          !Array.isArray(item.dimensions) ||
          item.dimensions.length < 3,
      )
    )
      return null;
    const workspace = candidate as EffectPromptWorkspace;
    return {
      ...workspace,
      hasGenerated: candidate.hasGenerated === true,
      settings: normalizePromptSettings(workspace.settings),
      items: workspace.items.map(clonePromptItem),
      metrics: metricsFor(workspace.items, workspace.metrics.removedDuplicates),
    };
  } catch {
    return null;
  }
};

export const persistEffectPromptWorkspace = (
  context: EffectPromptContext,
  workspace: EffectPromptWorkspace,
  options?: PromptMockOptions,
): EffectPromptWorkspace => {
  const copy = clonePromptWorkspace({ ...workspace, updatedAt: new Date().toISOString() });
  try {
    availableStorage(options)?.setItem(storageKey(context), JSON.stringify(copy));
  } catch {
    // Storage may be unavailable in private or quota-constrained browser contexts.
  }
  return copy;
};

export const loadEffectPromptWorkspace = async (
  context: EffectPromptContext,
  product: PromptProduct,
  config: EffectVideoConfig,
  signal?: AbortSignal,
  options?: PromptMockOptions,
): Promise<EffectPromptWorkspace> => {
  await waitForMock(options?.delayMs ?? 120, signal);
  const saved = parseWorkspace(availableStorage(options)?.getItem(storageKey(context)) ?? null);
  if (saved) return clonePromptWorkspace(saved);
  const initial = createWorkspace(product, config, {
    count: EFFECT_PROMPT_LIMITS.defaultCount,
    durationSeconds: 15,
    semanticLimit: EFFECT_PROMPT_LIMITS.maxSemanticSimilarity,
    visualLimit: EFFECT_PROMPT_LIMITS.maxVisualSimilarity,
  });
  return persistEffectPromptWorkspace(context, initial, options);
};

export const generateEffectPromptBatch = async (
  context: EffectPromptContext,
  product: PromptProduct,
  config: EffectVideoConfig,
  settings: EffectPromptBatchSettings,
  signal?: AbortSignal,
  options?: PromptMockOptions,
): Promise<EffectPromptWorkspace> => {
  await waitForMock(options?.delayMs ?? 720, signal);
  const generationSeed = Date.now() % 997;
  return persistEffectPromptWorkspace(
    context,
    createWorkspace(product, config, settings, generationSeed, true),
    options,
  );
};

export const regenerateEffectPrompt = async (
  context: EffectPromptContext,
  workspace: EffectPromptWorkspace,
  itemId: string,
  product: PromptProduct,
  config: EffectVideoConfig,
  signal?: AbortSignal,
  options?: PromptMockOptions,
): Promise<EffectPromptWorkspace> => {
  await waitForMock(options?.delayMs ?? 360, signal);
  const index = workspace.items.findIndex((item) => item.id === itemId);
  if (index < 0) throw new Error('未找到需要重新生成的 Prompt');
  const next = clonePromptWorkspace(workspace);
  next.items[index] = buildPromptItem(index, product, config, next.settings, Date.now() % 991);
  next.metrics = metricsFor(next.items, next.metrics.removedDuplicates + 1);
  return persistEffectPromptWorkspace(context, next, options);
};

export const updateEffectPrompt = (
  context: EffectPromptContext,
  workspace: EffectPromptWorkspace,
  itemId: string,
  content: string,
  options?: PromptMockOptions,
): EffectPromptWorkspace => {
  const next = clonePromptWorkspace(workspace);
  const item = next.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('未找到需要修改的 Prompt');
  item.content = content.trim();
  item.updatedAt = new Date().toISOString();
  return persistEffectPromptWorkspace(context, next, options);
};

export const addEffectPrompt = (
  context: EffectPromptContext,
  workspace: EffectPromptWorkspace,
  product: PromptProduct,
  config: EffectVideoConfig,
  content: string,
  options?: PromptMockOptions,
): EffectPromptWorkspace => {
  const next = clonePromptWorkspace(workspace);
  const generated = buildPromptItem(
    next.items.length,
    product,
    config,
    next.settings,
    Date.now() % 983,
  );
  generated.content = content.trim();
  next.items.push(generated);
  next.metrics = metricsFor(next.items, next.metrics.removedDuplicates);
  return persistEffectPromptWorkspace(context, next, options);
};

export const deleteEffectPrompt = (
  context: EffectPromptContext,
  workspace: EffectPromptWorkspace,
  itemId: string,
  options?: PromptMockOptions,
): EffectPromptWorkspace => {
  const next = clonePromptWorkspace(workspace);
  next.items = next.items.filter((item) => item.id !== itemId);
  next.metrics = metricsFor(next.items, next.metrics.removedDuplicates);
  return persistEffectPromptWorkspace(context, next, options);
};

export const resetEffectPromptWorkspace = (
  context: EffectPromptContext,
  options?: PromptMockOptions,
): void => availableStorage(options)?.removeItem(storageKey(context));

export const createEffectPromptExport = (
  workspace: EffectPromptWorkspace,
  productName: string,
): { content: string; fileName: string; mimeType: string } => ({
  content: JSON.stringify(
    {
      productName,
      settings: workspace.settings,
      metrics: workspace.metrics,
      prompts: workspace.items,
    },
    null,
    2,
  ),
  fileName: `${productName || '当前商品'}-差异化Prompt-${workspace.items.length}条.json`,
  mimeType: 'application/json;charset=utf-8',
});
