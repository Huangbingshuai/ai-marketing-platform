<script setup lang="ts">
import type {
  EffectImportMode,
  EffectImportProduct,
  EffectVideoConfig,
} from '@ai-marketing/contracts';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CloudUpload,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import {
  cloneExtractionProductState,
  EFFECT_EXTRACTION_STATUS_META,
  isExtractionReadyForNext,
  type EffectExtractionProductState,
} from './effect-info-extraction-state';
import {
  mockEffectInfoExtractionService,
  type EffectExtractionContext,
} from './services/effect-info-extraction.service';

const props = defineProps<{
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
  products: EffectImportProduct[];
  globalConfig: EffectVideoConfig;
}>();

const emit = defineEmits<{
  back: [];
  next: [];
}>();

const productStates = ref<Record<string, EffectExtractionProductState>>({});
const currentProductId = ref('');
const loading = ref(true);
const loadingError = ref('');
const batchBusy = ref(false);
const newDisabledElement = ref('');
let loadGeneration = 0;
let disposed = false;

const context = computed<EffectExtractionContext>(() => ({
  projectId: props.projectId,
  draftId: props.draftId,
  mode: props.mode,
}));

const sourceSignature = computed(() =>
  JSON.stringify(
    props.products.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      sku: product.sku,
      effectiveConfig: product.effectiveConfig,
      materials: product.materials.map((material) => ({
        id: material.id,
        status: material.status,
        updatedAt: material.updatedAt,
      })),
    })),
  ),
);

const currentProduct = computed(
  () => props.products.find((product) => product.id === currentProductId.value) ?? null,
);
const currentState = computed(() => productStates.value[currentProductId.value] ?? null);
const currentConfig = computed(
  () => currentProduct.value?.effectiveConfig ?? props.globalConfig,
);
const currentStatusMeta = computed(() =>
  currentState.value
    ? EFFECT_EXTRACTION_STATUS_META[currentState.value.status]
    : EFFECT_EXTRACTION_STATUS_META.NOT_GENERATED,
);
const readyForNext = computed(() => isExtractionReadyForNext(currentState.value));
const extractionTargets = computed(() =>
  props.products.filter((product) => productStates.value[product.id]?.status !== 'COMPLETED'),
);
const readyMaterialCount = computed(
  () => currentProduct.value?.materials.filter((material) => material.status === 'READY').length ?? 0,
);
const saveStateLabel = computed(() => {
  const state = currentState.value?.saveState ?? 'CLEAN';
  return {
    CLEAN: '尚未保存',
    DIRTY: '有未保存修改',
    SAVING: '正在保存…',
    SAVED: '草稿已保存',
    SAVE_FAILED: '保存失败',
  }[state];
});
const currentActionLabel = computed(() => {
  if (!currentState.value) return '开始 AI 提炼';
  if (currentState.value.status === 'PROCESSING') return 'AI 提炼中…';
  if (currentState.value.status === 'NOT_GENERATED') return '开始 AI 提炼';
  return '重新 AI 提炼';
});

const stateLabel = (productId: string): string => {
  const status = productStates.value[productId]?.status ?? 'NOT_GENERATED';
  return EFFECT_EXTRACTION_STATUS_META[status].label;
};

const replaceState = (state: EffectExtractionProductState): void => {
  productStates.value = {
    ...productStates.value,
    [state.productId]: cloneExtractionProductState(state),
  };
};

const patchProductState = (
  productId: string,
  patch: Partial<EffectExtractionProductState>,
): void => {
  const existing = productStates.value[productId];
  if (!existing) return;
  replaceState({ ...existing, ...patch });
};

const loadWorkspace = async (): Promise<void> => {
  const generation = ++loadGeneration;
  loading.value = true;
  loadingError.value = '';
  try {
    const states = await mockEffectInfoExtractionService.loadWorkspace(
      context.value,
      props.products,
    );
    if (disposed || generation !== loadGeneration) return;
    productStates.value = Object.fromEntries(states.map((state) => [state.productId, state]));
    if (!props.products.some((product) => product.id === currentProductId.value)) {
      currentProductId.value = props.products[0]?.id ?? '';
    }
  } catch (error) {
    if (disposed || generation !== loadGeneration) return;
    loadingError.value = error instanceof Error ? error.message : '提炼工作区加载失败';
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false;
  }
};

const runCurrentExtraction = async (): Promise<void> => {
  const product = currentProduct.value;
  const state = currentState.value;
  if (!product || !state || state.status === 'PROCESSING') return;
  patchProductState(product.id, { status: 'PROCESSING', errorMessage: null });
  const result = await mockEffectInfoExtractionService.extractProduct(context.value, product);
  if (!disposed) replaceState(result);
};

const runBatchExtraction = async (): Promise<void> => {
  const targets = extractionTargets.value;
  if (!targets.length || batchBusy.value) return;
  batchBusy.value = true;
  targets.forEach((product) =>
    patchProductState(product.id, { status: 'PROCESSING', errorMessage: null }),
  );
  try {
    const states = await mockEffectInfoExtractionService.extractAll(context.value, targets);
    if (!disposed) states.forEach(replaceState);
  } finally {
    if (!disposed) batchBusy.value = false;
  }
};

const markDirty = (): void => {
  if (!currentState.value?.result || currentState.value.saveState === 'SAVING') return;
  currentState.value.saveState = 'DIRTY';
};

const addSellingPoint = (): void => {
  const result = currentState.value?.result;
  if (!result || result.coreSellingPoints.length >= 3) return;
  result.coreSellingPoints.push('补充新的核心卖点');
  markDirty();
};

const removeSellingPoint = (index: number): void => {
  const result = currentState.value?.result;
  if (!result || result.coreSellingPoints.length <= 1) return;
  result.coreSellingPoints.splice(index, 1);
  markDirty();
};

const addDisabledElement = (): void => {
  const result = currentState.value?.result;
  const value = newDisabledElement.value.trim();
  if (!result || !value || result.disabledElements.includes(value)) return;
  result.disabledElements.push(value);
  newDisabledElement.value = '';
  markDirty();
};

const removeDisabledElement = (index: number): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result.disabledElements.splice(index, 1);
  markDirty();
};

const saveDraft = async (): Promise<void> => {
  const product = currentProduct.value;
  const state = currentState.value;
  if (!product || !state?.result || state.saveState === 'SAVING') return;
  state.saveState = 'SAVING';
  try {
    const saved = await mockEffectInfoExtractionService.saveDraft(
      context.value,
      product,
      state.result,
    );
    if (!disposed) replaceState(saved);
  } catch {
    if (!disposed) state.saveState = 'SAVE_FAILED';
  }
};

const selectProduct = (event: Event): void => {
  currentProductId.value = (event.target as HTMLSelectElement).value;
  newDisabledElement.value = '';
};

watch(
  [() => props.projectId, () => props.draftId, () => props.mode, sourceSignature],
  () => void loadWorkspace(),
  { immediate: true },
);

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
});
</script>

<template>
  <section class="effect-extraction-node" aria-labelledby="effect-extraction-title">
    <section v-if="loading" class="extraction-page-state" role="status">
      <LoaderCircle class="spin" :size="31" />
      <h2>正在准备 AI 信息提炼</h2>
      <p>载入当前项目的产品资料与独立提炼草稿…</p>
    </section>
    <section v-else-if="loadingError" class="extraction-page-state error" role="alert">
      <AlertCircle :size="31" />
      <h2>AI 信息提炼加载失败</h2>
      <p>{{ loadingError }}</p>
      <button type="button" @click="loadWorkspace"><RefreshCw :size="14" />重新加载</button>
    </section>
    <section v-else-if="!currentProduct || !currentState" class="extraction-page-state">
      <FileText :size="31" />
      <h2>暂无可提炼的产品</h2>
      <p>请返回资料包导入节点补充并校验产品资料。</p>
      <button type="button" @click="emit('back')"><ArrowLeft :size="14" />返回上一步</button>
    </section>

    <template v-else>
      <header class="extraction-heading">
        <div class="extraction-heading__title">
          <span>02</span>
          <div>
            <h2 id="effect-extraction-title">产品素材制作信息卡</h2>
            <p>AI 结果可逐项修订，每个产品独立保存提炼状态与草稿</p>
          </div>
        </div>
        <div class="extraction-heading__actions">
          <label class="product-switcher">
            <span class="visually-hidden">当前产品</span>
            <select :value="currentProductId" @change="selectProduct">
              <option v-for="product in products" :key="product.id" :value="product.id">
                {{ product.name || product.sku }} · {{ stateLabel(product.id) }}
              </option>
            </select>
          </label>
          <span class="status-pill" :class="currentStatusMeta.tone">
            <LoaderCircle
              v-if="currentState.status === 'PROCESSING'"
              class="spin"
              :size="12"
            />
            {{ currentStatusMeta.label }}
          </span>
          <button
            class="secondary-button"
            type="button"
            :disabled="currentState.status === 'PROCESSING' || batchBusy"
            @click="runCurrentExtraction"
          >
            <LoaderCircle
              v-if="currentState.status === 'PROCESSING'"
              class="spin"
              :size="14"
            />
            <RefreshCw v-else :size="14" />{{ currentActionLabel }}
          </button>
          <button
            v-if="mode === 'BATCH'"
            class="primary-button"
            type="button"
            :disabled="!extractionTargets.length || batchBusy"
            @click="runBatchExtraction"
          >
            <LoaderCircle v-if="batchBusy" class="spin" :size="14" />
            <Sparkles v-else :size="14" />全部提炼
          </button>
        </div>
      </header>

      <div v-if="currentState.status === 'FAILED'" class="state-alert danger" role="alert">
        <AlertCircle :size="17" />
        <div>
          <strong>本次 AI 提炼失败</strong>
          <p>{{ currentState.errorMessage }}</p>
        </div>
        <button type="button" @click="runCurrentExtraction">
          <RefreshCw :size="13" />重新提炼
        </button>
      </div>
      <div v-else-if="currentState.status === 'STALE'" class="state-alert warning">
        <AlertCircle :size="17" />
        <div>
          <strong>上游产品资料已发生变化</strong>
          <p>当前结果仍可查看和编辑，重新提炼后才能进入下一节点。</p>
        </div>
        <button type="button" @click="runCurrentExtraction">
          <RefreshCw :size="13" />更新提炼结果
        </button>
      </div>

      <div class="product-info-layout">
        <section class="content-block product-base-card">
          <h3>产品基础层</h3>
          <div class="base-fields">
            <label><span>品类</span><input :value="currentProduct.category || '未填写'" readonly /></label>
            <label><span>产品名称</span><input :value="currentProduct.name || '未填写'" readonly /></label>
            <label><span>SKU</span><input :value="currentProduct.sku || '未填写'" readonly /></label>
            <label
              ><span>资料完整度</span
              ><input
                :value="`${readyMaterialCount} / ${currentProduct.materials.length} 项资料可用`"
                readonly
            /></label>
            <label class="wide"
              ><span>资料概况</span
              ><textarea
                :value="currentProduct.materials.length ? currentProduct.materials.map((material) => material.originalFileName || material.expectedFileName || '待补充资料').join('、') : '尚未上传产品资料'"
                readonly
            /></label>
          </div>
        </section>
        <aside class="inherit-card">
          <span>继承自步骤 1 · 只读</span>
          <h3>统一制作规则</h3>
          <dl>
            <div><dt>画幅</dt><dd>{{ currentConfig.aspectRatio }}</dd></div>
            <div><dt>时长</dt><dd>{{ currentConfig.durationSeconds }} 秒</dd></div>
            <div><dt>风格</dt><dd>{{ currentConfig.styleTone }}</dd></div>
            <div><dt>渠道</dt><dd>{{ currentConfig.deliveryChannel }}</dd></div>
          </dl>
          <p>如需修改，请返回步骤 1；变更后当前产品会标记为待更新。</p>
        </aside>
      </div>

      <section v-if="currentState.status === 'PROCESSING'" class="processing-card" role="status">
        <span><LoaderCircle class="spin" :size="24" /></span>
        <div>
          <h3>正在提炼当前产品信息</h3>
          <p>本地 Mock 正在整理目标人群、卖点、场景、渠道与合规信息。</p>
        </div>
        <div class="processing-lines"><i /><i /><i /></div>
      </section>

      <section v-else-if="!currentState.result" class="empty-result-card">
        <span><Sparkles :size="25" /></span>
        <h3>{{ currentState.status === 'FAILED' ? '等待重新提炼' : '尚未生成提炼结果' }}</h3>
        <p>点击“开始 AI 提炼”，本地 Mock 将为当前产品生成可编辑的信息卡。</p>
        <button type="button" @click="runCurrentExtraction">
          <Sparkles :size="14" />开始 AI 提炼
        </button>
      </section>

      <div v-else class="result-grid" :class="{ muted: currentState.status === 'FAILED' }">
        <section class="content-block">
          <div class="block-heading">
            <div><h3>用户与目标</h3><p>明确本轮营销沟通对象与转化方向</p></div>
          </div>
          <label class="field-label">
            <span>目标人群</span>
            <textarea v-model="currentState.result.targetAudience" @input="markDirty" />
          </label>
          <label class="field-label">
            <span>营销目标</span>
            <textarea v-model="currentState.result.marketingGoal" @input="markDirty" />
          </label>
        </section>

        <section class="content-block">
          <div class="block-heading">
            <div><h3>卖点分层</h3><p>核心卖点建议保留 1–3 个</p></div>
            <button
              type="button"
              :disabled="currentState.result.coreSellingPoints.length >= 3"
              @click="addSellingPoint"
            ><Plus :size="13" />添加卖点</button>
          </div>
          <div class="selling-points">
            <div
              v-for="(_point, index) in currentState.result.coreSellingPoints"
              :key="index"
              class="selling-point-row"
            >
              <span>核心卖点</span>
              <input v-model="currentState.result.coreSellingPoints[index]" @input="markDirty" />
              <button
                type="button"
                aria-label="删除卖点"
                :disabled="currentState.result.coreSellingPoints.length <= 1"
                @click="removeSellingPoint(index)"
              ><Trash2 :size="14" /></button>
            </div>
          </div>
        </section>

        <section class="content-block">
          <div class="block-heading">
            <div><h3>场景与投放</h3><p>统一使用情境与内容分发方向</p></div>
          </div>
          <label class="field-label">
            <span>使用场景</span>
            <textarea v-model="currentState.result.usageScenarios" @input="markDirty" />
          </label>
          <label class="field-label">
            <span>投放渠道</span>
            <input v-model="currentState.result.deliveryChannels" @input="markDirty" />
          </label>
        </section>

        <section class="content-block">
          <div class="block-heading">
            <div><h3>品牌与合规</h3><p>禁用元素沿用原型标签式编辑</p></div>
          </div>
          <label class="field-label">
            <span>品牌调性</span>
            <input v-model="currentState.result.brandTone" @input="markDirty" />
          </label>
          <div class="field-label disabled-field">
            <span>禁用元素</span>
            <div class="disabled-tags">
              <button
                v-for="(element, index) in currentState.result.disabledElements"
                :key="`${element}-${index}`"
                type="button"
                @click="removeDisabledElement(index)"
              >{{ element }} <b>×</b></button>
            </div>
            <div class="disabled-input-row">
              <input
                v-model="newDisabledElement"
                placeholder="输入新禁用元素"
                @keydown.enter.prevent="addDisabledElement"
              />
              <button type="button" @click="addDisabledElement">添加</button>
            </div>
          </div>
        </section>
      </div>

      <section v-if="currentState.result" class="draft-save-bar">
        <span class="draft-save-bar__icon"><FileText :size="18" /></span>
        <div>
          <strong>AI 营销信息提炼草稿</strong>
          <small>{{ currentProduct.name }} · {{ projectId }} · 当前产品独立保存</small>
        </div>
        <em :class="currentState.saveState.toLowerCase()">{{ saveStateLabel }}</em>
        <button
          type="button"
          :disabled="currentState.saveState === 'SAVING' || currentState.saveState === 'SAVED'"
          @click="saveDraft"
        >
          <LoaderCircle v-if="currentState.saveState === 'SAVING'" class="spin" :size="14" />
          <Save v-else :size="14" />保存草稿
        </button>
      </section>

      <footer class="extraction-footer">
        <button type="button" @click="emit('back')"><ArrowLeft :size="14" />上一步</button>
        <div class="extraction-footer__status" :class="{ ready: readyForNext }">
          <CheckCircle2 v-if="readyForNext" :size="17" />
          <CloudUpload v-else :size="17" />
          <span>
            <strong>{{ readyForNext ? '当前产品已完成提炼' : '完成当前产品提炼后可继续' }}</strong>
            <small>步骤 2 / 6 · {{ currentProduct.name }} · {{ currentStatusMeta.label }}</small>
          </span>
        </div>
        <button
          class="primary-button"
          type="button"
          :disabled="!readyForNext"
          @click="emit('next')"
        >下一步：Prompt 生成<ArrowRight :size="14" /></button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.effect-extraction-node {
  --effect-blue: #2563eb;
  min-height: 460px;
  padding: 28px;
  color: #253047;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 26px;
  box-shadow: 0 12px 34px #7a4e3b12;
}
.extraction-heading {
  display: flex;
  min-height: 50px;
  margin-bottom: 22px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.extraction-heading__title {
  display: flex;
  min-width: 330px;
  align-items: center;
  gap: 13px;
}
.extraction-heading__title > span {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  color: #d83e69;
  background: #fff0f4;
  border-radius: 14px;
  font-size: 13px;
  font-weight: 900;
}
.extraction-heading h2,
.extraction-heading p {
  margin: 0;
}
.extraction-heading h2 {
  color: #172033;
  font-size: 21px;
}
.extraction-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 12px;
}
.extraction-heading__actions {
  display: flex;
  margin-left: auto;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.product-switcher select {
  width: 220px;
  height: 40px;
  padding: 0 32px 0 12px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  outline: 0;
  font-size: 12px;
}
.product-switcher select:focus,
input:focus,
textarea:focus {
  border-color: #7da7ef;
  box-shadow: 0 0 0 3px #2563eb14;
  outline: 0;
}
.status-pill {
  display: inline-flex;
  min-height: 24px;
  padding: 2px 8px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #64748b;
  background: #f3f6fa;
  border: 1px solid #dce5f1;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
.status-pill.success { color: #0f8a68; background: #eefaf6; border-color: #ccebdc; }
.status-pill.running { color: #2563eb; background: #eef4ff; border-color: #cfe0ff; }
.status-pill.warning { color: #b7791f; background: #fff8e8; border-color: #f2dfb4; }
.status-pill.danger { color: #dc3f52; background: #fff1f2; border-color: #f7c8ce; }
.secondary-button,
.primary-button,
.extraction-page-state button,
.state-alert button,
.empty-result-card button {
  display: inline-flex;
  height: 40px;
  padding: 0 14px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.primary-button,
.empty-result-card button {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
  box-shadow: 0 8px 18px #2563eb2e;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
  box-shadow: none !important;
}
.state-alert {
  display: flex;
  min-height: 58px;
  margin: 0 0 18px;
  padding: 10px 12px;
  align-items: center;
  gap: 10px;
  border-radius: 12px;
}
.state-alert > div {
  min-width: 0;
  flex: 1;
}
.state-alert strong,
.state-alert p { margin: 0; }
.state-alert strong { font-size: 12px; }
.state-alert p { margin-top: 3px; font-size: 10px; line-height: 1.5; }
.state-alert button { height: 32px; padding: 0 10px; }
.state-alert.danger { color: #a53d4b; background: #fff1f2; border: 1px solid #f7c8ce; }
.state-alert.warning { color: #956315; background: #fff8e8; border: 1px solid #f2dfb4; }
.product-info-layout {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(240px, 1fr);
  gap: 18px;
}
.content-block,
.inherit-card {
  padding: 20px;
  background: #fff;
  border: 1px solid #f0e2db;
  border-radius: 20px;
}
.product-base-card,
.inherit-card {
  min-height: 346px;
}
.content-block h3,
.inherit-card h3 { margin: 0; color: #263247; font-size: 15px; }
.base-fields {
  display: grid;
  margin-top: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.base-fields label,
.field-label {
  display: grid;
  gap: 8px;
  color: #596278;
  font-size: 12px;
  font-weight: 650;
}
.base-fields label.wide { grid-column: 1 / -1; }
input,
textarea,
select { font: inherit; }
.base-fields input,
.base-fields textarea,
.field-label input,
.field-label textarea,
.selling-point-row input,
.disabled-input-row input {
  width: 100%;
  color: #42526a;
  background: #fff;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  outline: 0;
  font-size: 12px;
  font-weight: 400;
}
.base-fields input,
.field-label input,
.selling-point-row input,
.disabled-input-row input { height: 40px; padding: 0 11px; }
.base-fields textarea,
.field-label textarea { min-height: 58px; padding: 8px 11px; line-height: 1.6; resize: vertical; }
.base-fields input[readonly],
.base-fields textarea[readonly] { color: #66758c; background: #fafbfd; }
.inherit-card {
  background: linear-gradient(145deg, #fffdfb, #fff6f2);
  border-color: #f7d6c7;
}
.inherit-card > span {
  display: inline-flex;
  padding: 4px 8px;
  color: #d9574e;
  background: #fff;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 800;
}
.inherit-card h3 { margin: 14px 0 10px; }
.inherit-card dl { margin: 0; }
.inherit-card dl > div {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid #f2ddd5;
}
.inherit-card dt { color: #927d76; font-size: 10px; }
.inherit-card dd { margin: 0; color: #37435a; font-size: 10px; font-weight: 800; text-align: right; }
.inherit-card p { margin: 12px 0 0; color: #a08377; font-size: 9px; line-height: 1.7; }
.processing-card,
.empty-result-card {
  display: flex;
  min-height: 310px;
  margin-top: 18px;
  padding: 34px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #77879e;
  background: #fbfdff;
  border: 1px dashed #bfcde0;
  border-radius: 20px;
  text-align: center;
}
.processing-card > span,
.empty-result-card > span {
  display: grid;
  width: 52px;
  height: 52px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 16px;
}
.processing-card h3,
.empty-result-card h3 { margin: 13px 0 5px; color: #34445c; font-size: 15px; }
.processing-card p,
.empty-result-card p { margin: 0; font-size: 10px; }
.empty-result-card button { margin-top: 16px; }
.processing-lines {
  display: grid;
  width: min(380px, 90%);
  margin-top: 20px;
  gap: 7px;
}
.processing-lines i { height: 7px; background: linear-gradient(90deg, #dce8fb, #f3f7fd, #dce8fb); border-radius: 999px; animation: shimmer 1.2s ease-in-out infinite alternate; }
.processing-lines i:nth-child(2) { width: 78%; }
.processing-lines i:nth-child(3) { width: 60%; }
.result-grid {
  display: grid;
  margin-top: 18px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.result-grid .content-block {
  min-height: 305px;
}
.result-grid.muted { opacity: 0.78; }
.block-heading {
  display: flex;
  margin-bottom: 15px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.block-heading h3,
.block-heading p { margin: 0; }
.block-heading p { margin-top: 4px; color: #909aaa; font-size: 9px; }
.block-heading button {
  display: inline-flex;
  height: 32px;
  padding: 0 10px;
  align-items: center;
  gap: 5px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 9px;
  font-size: 9px;
  font-weight: 700;
}
.field-label + .field-label { margin-top: 14px; }
.selling-points { display: grid; gap: 10px; }
.selling-point-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 36px;
  gap: 8px;
}
.selling-point-row > span {
  display: flex;
  height: 40px;
  align-items: center;
  justify-content: center;
  color: #596278;
  background: #f8fafc;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 650;
}
.selling-point-row button {
  display: grid;
  width: 36px;
  height: 40px;
  padding: 0;
  place-items: center;
  color: #7b8799;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.disabled-field { margin-top: 14px; }
.disabled-tags { display: flex; min-height: 28px; flex-wrap: wrap; gap: 6px; }
.disabled-tags button {
  display: inline-flex;
  min-height: 24px;
  padding: 2px 8px;
  align-items: center;
  gap: 5px;
  color: #dc3f52;
  background: #fff1f2;
  border: 1px solid #f7c8ce;
  border-radius: 7px;
  font-size: 9px;
}
.disabled-tags b { font-size: 12px; }
.disabled-input-row { display: grid; grid-template-columns: minmax(0, 1fr) 58px; gap: 8px; }
.disabled-input-row button {
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 700;
}
.draft-save-bar {
  display: flex;
  min-height: 67px;
  margin-top: 18px;
  padding: 12px 16px;
  align-items: center;
  gap: 12px;
  background: linear-gradient(90deg, #f4f8ff, #fff);
  border: 1px solid #d8e3f3;
  border-radius: 14px;
}
.draft-save-bar__icon { display: grid; width: 38px; height: 38px; place-items: center; color: #2563eb; background: #e8f1ff; border-radius: 11px; }
.draft-save-bar > div { min-width: 0; flex: 1; }
.draft-save-bar strong,
.draft-save-bar small { display: block; }
.draft-save-bar strong { font-size: 12px; }
.draft-save-bar small { margin-top: 3px; overflow: hidden; color: #7d899f; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.draft-save-bar em { padding: 5px 9px; color: #68768c; background: #eef2f7; border-radius: 999px; font-size: 9px; font-style: normal; }
.draft-save-bar em.dirty { color: #b7791f; background: #fff8e8; }
.draft-save-bar em.saved { color: #0f8a68; background: #eefaf6; }
.draft-save-bar em.save_failed { color: #dc3f52; background: #fff1f2; }
.draft-save-bar button {
  display: inline-flex;
  height: 36px;
  padding: 0 14px;
  align-items: center;
  gap: 5px;
  color: #fff;
  background: #2563eb;
  border: 1px solid #2563eb;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
.extraction-footer {
  display: grid;
  min-height: 72px;
  margin-top: 20px;
  padding: 13px 16px;
  align-items: center;
  grid-template-columns: 1fr auto 1fr;
  gap: 12px;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 20px;
  box-shadow: 0 8px 25px #7a4e3b12;
}
.extraction-footer > button {
  display: inline-flex;
  width: max-content;
  height: 40px;
  padding: 0 14px;
  align-items: center;
  gap: 6px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 700;
}
.extraction-footer > button:last-child { justify-self: end; color: #fff; background: #2563eb; border-color: #2563eb; }
.extraction-footer__status { display: flex; align-items: center; justify-content: center; gap: 8px; color: #718096; text-align: left; }
.extraction-footer__status.ready { color: #0f8a68; }
.extraction-footer__status strong,
.extraction-footer__status small { display: block; }
.extraction-footer__status strong { color: #41516a; font-size: 10px; }
.extraction-footer__status small { margin-top: 3px; font-size: 8px; }
.extraction-page-state { display: flex; min-height: 430px; padding: 30px; align-items: center; justify-content: center; flex-direction: column; color: #7f8da2; text-align: center; }
.extraction-page-state > svg { color: #2563eb; }
.extraction-page-state h2 { margin: 13px 0 5px; color: #34445c; font-size: 18px; }
.extraction-page-state p { margin: 0; font-size: 11px; }
.extraction-page-state button { margin-top: 15px; }
.extraction-page-state.error > svg { color: #dc3f52; }
.visually-hidden { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes shimmer { to { opacity: 0.45; transform: scaleX(0.92); } }
@media (max-width: 1120px) {
  .extraction-heading { align-items: flex-start; flex-direction: column; }
  .extraction-heading__actions { width: 100%; margin-left: 0; justify-content: flex-start; flex-wrap: wrap; }
  .product-switcher { flex: 1; }
  .product-switcher select { width: 100%; }
}
@media (max-width: 860px) {
  .product-info-layout,
  .result-grid { grid-template-columns: 1fr; }
  .extraction-footer { grid-template-columns: 1fr 1fr; }
  .extraction-footer__status { grid-column: 1 / -1; grid-row: 1; }
}
@media (max-width: 620px) {
  .effect-extraction-node { padding: 16px; }
  .base-fields { grid-template-columns: 1fr; }
  .base-fields label.wide { grid-column: auto; }
  .extraction-heading__title { min-width: 0; }
  .extraction-heading__actions > button { flex: 1; }
  .draft-save-bar { align-items: flex-start; flex-wrap: wrap; }
  .draft-save-bar > div { width: calc(100% - 52px); flex: none; }
  .draft-save-bar button { margin-left: auto; }
}
</style>
