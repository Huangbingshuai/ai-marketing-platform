<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  Check,
  ChevronDown,
  Clock3,
  FileText,
  LoaderCircle,
  Pencil,
  SlidersHorizontal,
  X,
} from '@lucide/vue';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_LIMITS,
  type EffectPromptDimensionKey,
  type EffectPromptFragmentType,
} from '@ai-marketing/contracts';
import type { PromptItemDraft } from '../services/effect-prompt-generation.service';
import {
  changePromptPrimaryPurpose,
  normalizeManualPromptDuration,
} from '../effect-prompt-generation-state';

const props = defineProps<{ editorMode: 'add' | 'edit'; editorSaving: boolean }>();
const editorDraft = defineModel<PromptItemDraft>('draft', { required: true });
const emit = defineEmits<{ close: []; save: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const contentInput = ref<HTMLTextAreaElement | null>(null);
const isAdd = computed(() => props.editorMode === 'add');
const dimensionLimits: Record<EffectPromptDimensionKey, number> = {
  narrative: 120,
  scene: 120,
  persona: 160,
  productRelation: 240,
  camera: 160,
  emotion: 120,
};
const fragmentTypeLabel = (type: EffectPromptFragmentType): string =>
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[type];
const purposeDescriptions: Record<EffectPromptFragmentType, string> = {
  HOOK: '吸引注意，建立观看兴趣',
  PRODUCT_DISPLAY: '呈现商品外观与细节',
  EFFECT: '展示使用状态与产品价值',
  CTA: '用于收束画面与转化',
};
const selectPrimaryPurpose = (purpose: EffectPromptFragmentType): void => {
  editorDraft.value.compatiblePurposes = changePromptPrimaryPurpose(
    editorDraft.value.primaryPurpose,
    purpose,
    editorDraft.value.compatiblePurposes,
  );
  editorDraft.value.primaryPurpose = purpose;
};
const close = (): void => {
  if (!props.editorSaving) emit('close');
};
const normalizeDurationInput = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  const duration = normalizeManualPromptDuration(input.valueAsNumber);
  input.value = String(duration);
  editorDraft.value.targetDurationSeconds = duration;
};
const limitDurationInput = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  const value = input.valueAsNumber;
  // Allow 1–3 while typing so entering 15 or 25 is not interrupted; commit on blur.
  if (
    Number.isFinite(value) &&
    (value > EFFECT_PROMPT_LIMITS.maxManualDurationSeconds ||
      value <= 0 ||
      !Number.isInteger(value))
  )
    normalizeDurationInput(event);
};
const submit = (): void => {
  if (!props.editorSaving) {
    // Read the actual input as well: v-model defers updates during IME composition.
    // Clicking Save must include the final text still visible in the textarea.
    if (contentInput.value) editorDraft.value.content = contentInput.value.value;
    if (isAdd.value)
      editorDraft.value.targetDurationSeconds = normalizeManualPromptDuration(
        editorDraft.value.targetDurationSeconds,
      );
    emit('save');
  }
};

onMounted(() => {
  dialog.value?.showModal();
  contentInput.value?.focus();
});
onBeforeUnmount(() => dialog.value?.close());
</script>

<template>
  <dialog
    ref="dialog"
    class="prompt-item-editor"
    :class="{ 'prompt-item-editor--edit': !isAdd }"
    aria-labelledby="prompt-editor-title"
    :aria-busy="editorSaving"
    @cancel.prevent="close"
    @click.self="close"
  >
    <form @submit.prevent="submit">
      <header class="editor-header">
        <div class="editor-heading">
          <span class="editor-heading-icon"
            ><FileText v-if="isAdd" :size="21" /><Pencil v-else :size="20"
          /></span>
          <div>
            <h2 id="prompt-editor-title">{{ isAdd ? '添加提示词' : '编辑提示词' }}</h2>
            <p>
              {{
                isAdd
                  ? '添加一条可独立使用的素材画面描述'
                  : '仅修改画面描述，原有片段类型与创意信息保持不变'
              }}
            </p>
          </div>
        </div>
        <button
          class="editor-close"
          type="button"
          aria-label="关闭提示词编辑窗口"
          :disabled="editorSaving"
          @click="close"
        >
          <X :size="18" />
        </button>
      </header>

      <div class="editor-body" :class="{ 'editor-body--add': isAdd }">
        <main class="editor-writing">
          <div v-if="!isAdd" class="editor-fixed-duration">
            <Clock3 :size="15" /><span>片段时长</span
            ><strong>{{ editorDraft.targetDurationSeconds }} 秒</strong>
            <small>最终渲染时长保持不变</small>
          </div>
          <section class="editor-content">
            <div class="editor-content-heading">
              <label for="prompt-editor-content">提示词正文</label>
              <span>画面描述</span>
            </div>
            <textarea
              id="prompt-editor-content"
              ref="contentInput"
              v-model="editorDraft.content"
              required
              maxlength="12000"
              rows="14"
              placeholder="输入或粘贴这条素材的画面描述…"
            />
            <div class="editor-content-meta">
              <small>{{ editorDraft.content.length.toLocaleString() }} / 12,000</small>
            </div>
          </section>

          <details v-if="isAdd" class="editor-optional">
            <summary>
              <span>创意方向与六大维度 <small>选填</small></span>
              <ChevronDown :size="16" />
            </summary>
            <div class="editor-optional-body">
              <p>可全部留空，也可以只记录需要的内容。</p>
              <label>
                <span>创意方向</span>
                <textarea
                  v-model="editorDraft.creativeCore"
                  maxlength="160"
                  rows="2"
                  placeholder="这条素材的创意想法"
                />
              </label>
              <div class="editor-dimensions">
                <label v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key">
                  <span>{{ dimension.label }}</span>
                  <textarea
                    v-model="editorDraft.dimensions[dimension.key]"
                    :maxlength="dimensionLimits[dimension.key]"
                    rows="2"
                    placeholder="可留空"
                  />
                </label>
              </div>
            </div>
          </details>
        </main>
        <aside v-if="isAdd" class="editor-settings">
          <h3><SlidersHorizontal :size="15" />素材设置</h3>
          <fieldset class="editor-primary-purpose">
            <legend>片段类型</legend>
            <label
              v-for="type in EFFECT_PROMPT_FRAGMENT_TYPES"
              :key="type"
              :class="{ selected: editorDraft.primaryPurpose === type }"
            >
              <input
                type="radio"
                name="prompt-primary-purpose"
                :value="type"
                :checked="editorDraft.primaryPurpose === type"
                @change="selectPrimaryPurpose(type)"
              />
              <span
                ><strong>{{ fragmentTypeLabel(type) }}</strong
                ><small>{{ purposeDescriptions[type] }}</small></span
              >
            </label>
          </fieldset>
          <label class="editor-duration-setting">
            <span><Clock3 :size="14" />片段时长</span>
            <div class="editor-duration-input">
              <input
                v-model.number="editorDraft.targetDurationSeconds"
                type="number"
                required
                :min="EFFECT_PROMPT_LIMITS.minDurationSeconds"
                :max="EFFECT_PROMPT_LIMITS.maxManualDurationSeconds"
                step="1"
                aria-describedby="prompt-duration-range"
                @input="limitDurationInput"
                @blur="normalizeDurationInput"
              />
              <span>秒</span>
            </div>
            <small id="prompt-duration-range" class="editor-duration-hint">
              {{ EFFECT_PROMPT_LIMITS.minDurationSeconds }}～{{
                EFFECT_PROMPT_LIMITS.maxManualDurationSeconds
              }}
              秒，整数
            </small>
          </label>
          <fieldset class="editor-purposes">
            <legend>还适合的片段类型 <span>选填</span></legend>
            <div>
              <label
                v-for="purpose in EFFECT_PROMPT_FRAGMENT_TYPES.filter(
                  (value) => value !== editorDraft.primaryPurpose,
                )"
                :key="purpose"
              >
                <input v-model="editorDraft.compatiblePurposes" type="checkbox" :value="purpose" />
                <span class="editor-purpose-chip"
                  ><Check :size="12" />{{ fragmentTypeLabel(purpose) }}</span
                >
              </label>
            </div>
          </fieldset>
        </aside>
      </div>

      <footer class="editor-footer">
        <span class="editor-footer-note">更改仅在保存后生效</span>
        <button type="button" :disabled="editorSaving" @click="close">取消</button>
        <button
          class="editor-save"
          type="submit"
          :disabled="editorSaving"
          :aria-busy="editorSaving"
        >
          <LoaderCircle v-if="editorSaving" :size="15" class="spin" />
          {{ editorSaving ? '保存中…' : isAdd ? '添加提示词' : '保存修改' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.prompt-item-editor {
  --editor-blue: var(--effect-blue, #2563eb);
  width: min(1040px, calc(100vw - 48px));
  max-width: none;
  max-height: calc(100dvh - 48px);
  margin: auto;
  padding: 0;
  color: #263650;
  background: #fff;
  border: 1px solid #dbe3ef;
  border-radius: 18px;
  box-shadow:
    0 28px 90px #0f172a33,
    0 6px 20px #0f172a0d;
  overflow: hidden;
  font-family: inherit;
}
.prompt-item-editor--edit {
  width: min(920px, calc(100vw - 48px));
}
.prompt-item-editor::backdrop {
  background: #18233670;
}
form {
  display: flex;
  max-height: calc(100dvh - 50px);
  flex-direction: column;
}
.editor-header {
  display: flex;
  flex-shrink: 0;
  padding: 24px 28px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  border-bottom: 1px solid #e8edf4;
}
.editor-heading {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.editor-heading-icon {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid #dbe7ff;
  border-radius: 13px;
  background: #f0f5ff;
  color: var(--editor-blue);
}
h2 {
  margin: 0;
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.4px;
  line-height: 1.45;
}
.editor-heading p {
  margin: 5px 0 0;
  color: #8491a5;
  font-size: 12px;
  line-height: 1.6;
}
button,
input,
textarea {
  font: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: wait;
  opacity: 0.6;
}
.editor-close {
  display: grid;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  place-items: center;
  color: #7b8ba2;
  background: transparent;
  border: 0;
  border-radius: 8px;
}
.editor-close:hover {
  background: #f0f4fa;
  color: #34455f;
}
.editor-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: #f8fafd;
  scrollbar-width: thin;
  scrollbar-color: #c8d2e1 transparent;
}
.editor-body--add {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 256px;
}
.editor-writing {
  min-width: 0;
  padding: 24px 28px;
}
.editor-content {
  overflow: hidden;
  border: 1px solid #dce4ef;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 5px #24365204;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.editor-content:focus-within {
  border-color: #94b3f5;
  box-shadow: 0 0 0 3px #2563eb09;
}
.editor-content-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid #edf1f6;
}
.editor-content-heading label {
  font-size: 13px;
  font-weight: 600;
  color: #34455f;
}
.editor-content-heading > span {
  font-size: 11px;
  color: #98a4b5;
}
.editor-content textarea {
  display: block;
  width: 100%;
  min-height: 360px;
  box-sizing: border-box;
  padding: 18px;
  resize: vertical;
  font-size: 13px;
  line-height: 1.9;
  color: #40516c;
  border: 0;
  border-radius: 0;
  outline: none;
  background: #fff;
}
.prompt-item-editor--edit .editor-content textarea {
  min-height: 400px;
}
.editor-content-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px 13px;
  color: #9aa6b7;
  font-size: 11px;
}
.editor-content-meta small {
  font-size: inherit;
  font-variant-numeric: tabular-nums;
}
textarea::placeholder {
  color: #a0acbd;
}
.editor-settings {
  min-width: 0;
  padding: 24px 20px;
  border-left: 1px solid #e8edf4;
  background: #fff;
}
.editor-settings h3 {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0 0 24px;
  font-size: 13px;
  font-weight: 600;
  color: #43546e;
}
.editor-settings h3 svg {
  color: #8899b1;
}
fieldset {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
legend {
  margin-bottom: 11px;
  padding: 0;
  color: #7b8aa1;
  font-size: 12px;
  font-weight: 500;
}
.editor-primary-purpose {
  display: grid;
  gap: 8px;
}
.editor-primary-purpose label {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid #e4eaf2;
  border-radius: 9px;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.editor-primary-purpose label:hover {
  background: #f8fafd;
  border-color: #c4d2e7;
}
.editor-primary-purpose label.selected {
  background: #f4f7ff;
  border-color: #a8c2fb;
}
.editor-primary-purpose input {
  width: 14px;
  height: 14px;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--editor-blue);
}
.editor-primary-purpose label > span {
  display: grid;
  gap: 4px;
}
.editor-primary-purpose strong {
  color: #53637b;
  font-size: 12px;
  font-weight: 500;
}
.editor-primary-purpose .selected strong {
  color: var(--editor-blue);
  font-weight: 600;
}
.editor-primary-purpose small {
  color: #99a5b5;
  font-size: 10px;
  line-height: 1.5;
}
.editor-duration-setting {
  display: block;
  margin-top: 24px;
}
.editor-duration-setting > span {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: #7b8aa1;
  font-size: 12px;
}
.editor-duration-input {
  display: flex;
  height: 40px;
  align-items: center;
  background: #fafbfd;
  border: 1px solid #dfe6f0;
  border-radius: 8px;
}
.editor-duration-input input {
  width: 100%;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  box-sizing: border-box;
  background: transparent;
  color: #40516c;
  border: 0;
  outline: none;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.editor-duration-input > span {
  padding: 0 12px;
  color: #8b9ab0;
  font-size: 12px;
  border-left: 1px solid #e4eaf2;
}
.editor-duration-hint {
  display: block;
  margin-top: 7px;
  color: #96a3b7;
  font-size: 11px;
  line-height: 1.5;
}
.editor-duration-input:focus-within {
  border-color: #94b3f5;
  box-shadow: 0 0 0 3px #2563eb09;
}
.editor-fixed-duration {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  padding: 12px 15px;
  border: 1px solid #e0e8f3;
  border-radius: 9px;
  background: #f0f5fc;
  color: #7b8da8;
  font-size: 12px;
}
.editor-fixed-duration strong {
  padding-right: 12px;
  color: #405675;
  font-size: 13px;
  font-weight: 600;
  border-right: 1px solid #dce5f1;
}
.editor-fixed-duration small {
  color: #8496b0;
  font-size: 12px;
}
.editor-purposes {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid #edf1f6;
}
legend > span,
summary small {
  margin-left: 7px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #f0f3f8;
  color: #96a2b3;
  font-size: 10px;
  font-weight: 400;
}
.editor-purposes legend {
  float: left;
  margin-bottom: 12px;
}
.editor-purposes > div {
  display: grid;
  clear: both;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
}
.editor-purposes label {
  position: relative;
  display: block;
  min-width: 0;
  cursor: pointer;
}
.editor-purposes input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.editor-purpose-chip {
  display: flex;
  width: 100%;
  min-height: 34px;
  box-sizing: border-box;
  gap: 5px;
  align-items: center;
  justify-content: space-between;
  padding: 7px 11px;
  border: 1px solid #e2e8f2;
  border-radius: 6px;
  color: #8593a8;
  background: #fff;
  font-size: 11px;
}
.editor-purposes label:hover .editor-purpose-chip {
  border-color: #b8cdf8;
}
.editor-purpose-chip > svg {
  order: 1;
  flex-shrink: 0;
  visibility: hidden;
}
.editor-purposes input:checked + .editor-purpose-chip {
  border-color: #b8cdf8;
  background: #f2f6ff;
  color: #3867be;
}
.editor-purposes input:checked + .editor-purpose-chip > svg {
  visibility: visible;
}
.editor-purposes input:focus-visible + .editor-purpose-chip {
  outline: 2px solid #7da4ff;
  outline-offset: 2px;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid #7da4ff;
  outline-offset: 3px;
}
.editor-optional {
  margin-top: 18px;
  border: 1px solid #e0e7f1;
  border-radius: 10px;
  background: #fff;
}
summary {
  display: flex;
  padding: 16px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  list-style: none;
  color: #61728b;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}
summary:hover {
  color: #344d72;
}
summary::-webkit-details-marker {
  display: none;
}
summary > svg {
  flex-shrink: 0;
  color: #96a4b8;
  transition: transform 0.15s ease;
}
details[open] summary > svg {
  transform: rotate(180deg);
}
.editor-optional-body {
  padding: 0 16px 18px;
  border-top: 1px solid #edf1f6;
}
.editor-optional-body > p {
  margin: 12px 0 16px;
  color: #95a2b5;
  font-size: 11px;
  line-height: 1.6;
}
.editor-optional-body label > span {
  display: block;
  margin-bottom: 8px;
  color: #677892;
  font-size: 12px;
  font-weight: 500;
}
.editor-optional-body textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 78px;
  padding: 10px 12px;
  resize: vertical;
  color: #4c5f7a;
  background: #fbfcfe;
  border: 1px solid #e0e7f1;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.7;
}
.editor-optional-body textarea:focus {
  outline: none;
  border-color: #94b3f5;
  background: #fff;
}
.editor-dimensions {
  display: grid;
  margin-top: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.editor-footer {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 18px 28px;
  border-top: 1px solid #e7edf5;
  background: #fff;
}
.editor-footer-note {
  margin-right: auto;
  font-size: 11px;
  color: #a0acbd;
}
.editor-footer button {
  display: inline-flex;
  min-width: 84px;
  height: 38px;
  padding: 0 18px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #667791;
  background: #fff;
  border: 1px solid #dce4ef;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
}
.editor-footer button:hover {
  background: #f7f9fc;
}
.editor-footer .editor-save {
  color: #fff;
  background: var(--editor-blue);
  border-color: var(--editor-blue);
  box-shadow: 0 3px 8px #2563eb1c;
}
.editor-footer .editor-save:hover {
  color: #fff;
  background: #1d4ed8;
  border-color: #1d4ed8;
  filter: none;
}
.editor-footer .editor-save:disabled {
  color: #fff;
  background: #1d4ed8;
  border-color: #1d4ed8;
  opacity: 1;
  box-shadow: 0 3px 8px rgba(29, 78, 216, 0.2);
}
.editor-footer .editor-save:disabled:hover {
  filter: none;
}
.spin {
  animation: editor-spin 1s linear infinite;
}
@keyframes editor-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 800px) {
  .editor-body--add {
    grid-template-columns: minmax(0, 1fr);
  }
  .editor-settings {
    border-left: 0;
    border-top: 1px solid #e8edf4;
    padding: 20px 24px;
  }
  .editor-primary-purpose {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .editor-settings h3 {
    margin-bottom: 18px;
  }
  .editor-duration-setting {
    max-width: 180px;
  }
  .editor-purposes {
    margin-top: 18px;
    padding-top: 16px;
  }
}
@media (max-width: 600px) {
  .prompt-item-editor,
  .prompt-item-editor--edit {
    width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    border-radius: 14px;
  }
  form {
    max-height: calc(100dvh - 26px);
  }
  .editor-header {
    padding: 18px;
    gap: 10px;
  }
  .editor-heading {
    gap: 10px;
  }
  .editor-heading-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
  }
  h2 {
    font-size: 18px;
  }
  .editor-heading p {
    font-size: 11px;
  }
  .editor-writing {
    padding: 18px;
  }
  .editor-content textarea,
  .prompt-item-editor--edit .editor-content textarea {
    min-height: 280px;
    padding: 14px;
  }
  .editor-content-heading {
    padding: 12px 14px;
  }
  .editor-content-meta {
    padding: 9px 14px 12px;
  }
  .editor-fixed-duration small {
    flex-basis: 100%;
    margin: 0;
    padding-left: 23px;
  }
  .editor-fixed-duration strong {
    border-right: 0;
    padding-right: 0;
  }
  .editor-settings {
    padding: 20px 18px;
  }
  .editor-dimensions {
    grid-template-columns: minmax(0, 1fr);
  }
  .editor-footer {
    padding: 14px 18px;
  }
  .editor-footer-note {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .editor-content,
  .editor-primary-purpose label,
  summary > svg {
    transition: none;
  }
  .spin {
    animation: none;
  }
}
</style>
