import type { EffectImportMode, EffectVideoConfig } from '@ai-marketing/contracts';

import {
  cloneExtractionProductState,
  cloneExtractionResult,
  type EffectExtractionProductState,
  type EffectExtractionResult,
} from '../effect-info-extraction-state';

export type EffectExtractionSourceProduct = {
  id: string;
  name: string;
  category: string;
  sku: string;
  effectiveConfig: EffectVideoConfig;
  materials: Array<{
    id: string;
    status: string;
    updatedAt: string;
  }>;
};

export type EffectExtractionContext = {
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
};

export type EffectInfoExtractionService = {
  loadWorkspace: (
    context: EffectExtractionContext,
    products: EffectExtractionSourceProduct[],
  ) => Promise<EffectExtractionProductState[]>;
  extractProduct: (
    context: EffectExtractionContext,
    product: EffectExtractionSourceProduct,
  ) => Promise<EffectExtractionProductState>;
  extractAll: (
    context: EffectExtractionContext,
    products: EffectExtractionSourceProduct[],
  ) => Promise<EffectExtractionProductState[]>;
  saveDraft: (
    context: EffectExtractionContext,
    product: EffectExtractionSourceProduct,
    result: EffectExtractionResult,
  ) => Promise<EffectExtractionProductState>;
};

type StoredExtractionState = EffectExtractionProductState & {
  failNextExtraction: boolean;
};

const wait = (duration: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, duration));

const workspaceKey = (context: EffectExtractionContext, productId: string): string =>
  `${context.projectId}:${context.draftId}:${productId}`;

const sourceFingerprint = (product: EffectExtractionSourceProduct): string =>
  JSON.stringify({
    category: product.category,
    config: product.effectiveConfig,
    materials: product.materials.map(({ id, status, updatedAt }) => ({ id, status, updatedAt })),
    name: product.name,
    sku: product.sku,
  });

const normalizeCategory = (category: string): string => category.trim() || '当前品类';

const buildMockResult = (
  product: EffectExtractionSourceProduct,
  attempt = 1,
): EffectExtractionResult => {
  const category = normalizeCategory(product.category);
  const name = product.name.trim() || '当前产品';
  const channel = product.effectiveConfig.deliveryChannel || '抖音信息流';
  const tone = product.effectiveConfig.styleTone || '自然、可信、有生活感';
  return {
    targetAudience: `关注${category}品质与使用效率的 25–45 岁消费人群，兼顾家庭决策者与节庆送礼用户`,
    marketingGoal: `围绕“${name}”建立清晰产品认知，强化购买理由并提升${channel}场景下的点击与转化`,
    coreSellingPoints: [
      `${name}核心产品特征清晰，重点信息可在前三秒被快速识别`,
      `真实使用场景与细节展示结合，降低消费者理解与决策成本`,
      attempt > 1 ? '结合最新资料重新校准卖点顺序，突出差异化购买理由' : '规格、体验与使用方式表达完整，适合短视频转化链路',
    ],
    usageScenarios: '日常使用、家庭分享、节庆送礼、即时决策与内容种草场景',
    deliveryChannels: channel,
    brandTone: tone,
    disabledElements:
      product.effectiveConfig.disabledElements.length > 0
        ? [...product.effectiveConfig.disabledElements]
        : ['绝对化用语', '未经证实的功效承诺', '竞品商标'],
  };
};

const createInitialState = (
  mode: EffectImportMode,
  product: EffectExtractionSourceProduct,
  index: number,
): StoredExtractionState => {
  const now = new Date().toISOString();
  const fingerprint = sourceFingerprint(product);
  if (mode === 'BATCH' && index === 0) {
    return {
      productId: product.id,
      status: 'COMPLETED',
      saveState: 'SAVED',
      result: buildMockResult(product),
      errorMessage: null,
      sourceFingerprint: fingerprint,
      attempt: 1,
      savedAt: now,
      updatedAt: now,
      failNextExtraction: false,
    };
  }
  if (mode === 'BATCH' && index === 2) {
    return {
      productId: product.id,
      status: 'FAILED',
      saveState: 'CLEAN',
      result: null,
      errorMessage: '产品资料中的关键信息不完整，Mock 模型无法形成稳定提炼结果。',
      sourceFingerprint: fingerprint,
      attempt: 1,
      savedAt: null,
      updatedAt: now,
      failNextExtraction: false,
    };
  }
  if (mode === 'BATCH' && index === 3) {
    return {
      productId: product.id,
      status: 'STALE',
      saveState: 'SAVED',
      result: buildMockResult(product),
      errorMessage: null,
      sourceFingerprint: fingerprint,
      attempt: 1,
      savedAt: now,
      updatedAt: now,
      failNextExtraction: false,
    };
  }
  return {
    productId: product.id,
    status: 'NOT_GENERATED',
    saveState: 'CLEAN',
    result: null,
    errorMessage: null,
    sourceFingerprint: fingerprint,
    attempt: 0,
    savedAt: null,
    updatedAt: now,
    failNextExtraction: mode === 'BATCH' && index === 1,
  };
};

class MockEffectInfoExtractionService implements EffectInfoExtractionService {
  private readonly states = new Map<string, StoredExtractionState>();

  async loadWorkspace(
    context: EffectExtractionContext,
    products: EffectExtractionSourceProduct[],
  ): Promise<EffectExtractionProductState[]> {
    const states = products.map((product, index) => {
      const key = workspaceKey(context, product.id);
      const fingerprint = sourceFingerprint(product);
      const existing = this.states.get(key);
      if (!existing) {
        const initial = createInitialState(context.mode, product, index);
        this.states.set(key, initial);
        return cloneExtractionProductState(initial);
      }
      if (existing.sourceFingerprint !== fingerprint) {
        existing.sourceFingerprint = fingerprint;
        existing.updatedAt = new Date().toISOString();
        if (existing.status === 'COMPLETED') existing.status = 'STALE';
      }
      if (existing.status === 'PROCESSING') existing.status = 'NOT_GENERATED';
      return cloneExtractionProductState(existing);
    });
    return Promise.resolve(states);
  }

  async extractProduct(
    context: EffectExtractionContext,
    product: EffectExtractionSourceProduct,
  ): Promise<EffectExtractionProductState> {
    const key = workspaceKey(context, product.id);
    const existing =
      this.states.get(key) ?? createInitialState(context.mode, product, Number.MAX_SAFE_INTEGER);
    existing.status = 'PROCESSING';
    existing.errorMessage = null;
    existing.updatedAt = new Date().toISOString();
    this.states.set(key, existing);
    await wait(900);

    existing.attempt += 1;
    existing.updatedAt = new Date().toISOString();
    if (existing.failNextExtraction) {
      existing.failNextExtraction = false;
      existing.status = 'FAILED';
      existing.errorMessage = 'Mock 提炼服务暂时无法解析部分产品资料，请检查资料后重新提炼。';
      existing.saveState = 'CLEAN';
      return cloneExtractionProductState(existing);
    }

    existing.status = 'COMPLETED';
    existing.result = buildMockResult(product, existing.attempt);
    existing.errorMessage = null;
    existing.saveState = 'DIRTY';
    existing.sourceFingerprint = sourceFingerprint(product);
    return cloneExtractionProductState(existing);
  }

  async extractAll(
    context: EffectExtractionContext,
    products: EffectExtractionSourceProduct[],
  ): Promise<EffectExtractionProductState[]> {
    return Promise.all(products.map((product) => this.extractProduct(context, product)));
  }

  async saveDraft(
    context: EffectExtractionContext,
    product: EffectExtractionSourceProduct,
    result: EffectExtractionResult,
  ): Promise<EffectExtractionProductState> {
    await wait(260);
    const key = workspaceKey(context, product.id);
    const existing =
      this.states.get(key) ?? createInitialState(context.mode, product, Number.MAX_SAFE_INTEGER);
    existing.result = cloneExtractionResult(result);
    existing.saveState = 'SAVED';
    existing.savedAt = new Date().toISOString();
    existing.updatedAt = existing.savedAt;
    existing.sourceFingerprint = sourceFingerprint(product);
    this.states.set(key, existing);
    return cloneExtractionProductState(existing);
  }
}

export const mockEffectInfoExtractionService: EffectInfoExtractionService =
  new MockEffectInfoExtractionService();
