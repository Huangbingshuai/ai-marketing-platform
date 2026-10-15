<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ChevronDown, X } from '@lucide/vue';
import {
  effectPromptRenderSettingsIssues,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
} from '@ai-marketing/contracts';
import type {
  EffectSegmentRenderPromptInput,
  EffectSegmentRenderPromptSettings,
  EffectSegmentRenderSettings,
} from '@ai-marketing/contracts';
import { effectSegmentRenderModels } from '../effect-segment-render-models';

const props = defineProps<{
  inputs: EffectSegmentRenderPromptInput[];
  defaults: EffectSegmentRenderSettings;
}>();
const emit = defineEmits<{
  cancel: [];
  confirm: [settings: EffectSegmentRenderPromptSettings[]];
}>();
const dialog = ref<HTMLDialogElement | null>(null);
const drafts = ref(props.inputs.map((input) => ({ ...input, settings: { ...props.defaults } })));
const expandedPrompts = ref(new Set<string>());
const togglePrompt = (promptId: string) => {
  if (expandedPrompts.value.has(promptId)) expandedPrompts.value.delete(promptId);
  else expandedPrompts.value.add(promptId);
};
const issues = computed(() =>
  drafts.value.map((draft) => effectPromptRenderSettingsIssues(draft.settings, draft)),
);
const valid = computed(
  () => drafts.value.length > 0 && issues.value.every((entry) => !entry.length),
);
const completedCount = computed(() => issues.value.filter((entry) => !entry.length).length);
const originalIssues = (input: EffectSegmentRenderPromptInput) =>
  effectPromptRenderSettingsIssues(props.defaults, input).join('；');
const allowedModel = (
  input: EffectSegmentRenderPromptInput,
  key: EffectSegmentRenderSettings['capabilityKey'],
) => !effectPromptRenderSettingsIssues({ ...inputDefaults(key) }, input).length;
const inputDefaults = (
  key: EffectSegmentRenderSettings['capabilityKey'],
): EffectSegmentRenderSettings => ({
  capabilityKey: key,
  ratio: 'adaptive',
  resolution: EFFECT_PROMPT_RENDER_CAPABILITIES[key].resolutions[0]!,
});
const applyToAll = (settings: EffectSegmentRenderSettings) => {
  drafts.value.forEach((draft) => {
    draft.settings = { ...settings };
  });
};
const submit = () => {
  if (valid.value)
    emit(
      'confirm',
      drafts.value.map(({ promptId, settings }) => ({ promptId, settings: { ...settings } })),
    );
};
let trigger: HTMLElement | null = null;
let previousOverflow = '';
const keepDialogFocus = (event: KeyboardEvent) => {
  if (event.key !== 'Tab' || !dialog.value) return;
  const controls = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), [tabindex="0"]',
    ),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};
onMounted(() => {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.body.style.overflow = previousOverflow;
  if (trigger?.isConnected) trigger.focus();
});
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="prompt-render-configuration"
      aria-labelledby="prompt-render-config-title"
      aria-describedby="prompt-render-config-description"
      @cancel.prevent="emit('cancel')"
      @click.self="emit('cancel')"
      @keydown="keepDialogFocus"
    >
      <form @submit.prevent="submit">
        <header>
          <div>
            <h2 id="prompt-render-config-title">配置提示词渲染参数</h2>
            <p id="prompt-render-config-description">
              {{ inputs.length }} 条提示词与默认配置不兼容，请单独设置。
            </p>
          </div>
          <button type="button" class="close" aria-label="关闭渲染参数配置" @click="emit('cancel')">
            <X :size="18" />
          </button>
        </header>
        <div class="configuration-list">
          <section
            v-for="(draft, index) in drafts"
            :key="draft.promptId"
            class="configuration-item"
            :aria-labelledby="`config-prompt-${index}`"
          >
            <div class="item-heading">
              <div>
                <strong :id="`config-prompt-${index}`">{{ draft.promptCode }}</strong
                ><span>{{ draft.durationSeconds }} 秒</span>
              </div>
              <div class="item-actions">
                <button
                  type="button"
                  class="prompt-toggle"
                  :aria-label="`${draft.promptCode} ${expandedPrompts.has(draft.promptId) ? '收起提示词' : '查看提示词'}`"
                  :aria-expanded="expandedPrompts.has(draft.promptId)"
                  :aria-controls="`config-prompt-content-${index}`"
                  @click="togglePrompt(draft.promptId)"
                >
                  {{ expandedPrompts.has(draft.promptId) ? '收起提示词' : '查看提示词' }}
                  <ChevronDown
                    :size="13"
                    :class="{ expanded: expandedPrompts.has(draft.promptId) }"
                  />
                </button>
                <button
                  v-if="drafts.length > 1"
                  type="button"
                  class="apply-all"
                  :disabled="Boolean(issues[index]?.length)"
                  @click="applyToAll(draft.settings)"
                >
                  应用到全部冲突项
                </button>
              </div>
            </div>
            <div
              v-if="expandedPrompts.has(draft.promptId)"
              :id="`config-prompt-content-${index}`"
              class="prompt-content"
              role="region"
              :aria-label="`${draft.promptCode} 提示词正文`"
              tabindex="0"
            >
              {{ draft.promptText || '提示词内容暂未同步，请关闭后重新打开配置。' }}
            </div>
            <p class="conflict-reason">默认配置：{{ originalIssues(draft) }}</p>
            <div class="configuration-fields">
              <label class="model-field"
                >视频模型
                <select
                  v-model="draft.settings.capabilityKey"
                  :aria-label="`${draft.promptCode} 视频模型`"
                >
                  <option
                    v-for="model in effectSegmentRenderModels"
                    :key="model.value"
                    :value="model.value"
                    :disabled="!allowedModel(draft, model.value)"
                  >
                    {{ model.label }}
                  </option>
                </select>
              </label>
              <label
                >画幅
                <select v-model="draft.settings.ratio" :aria-label="`${draft.promptCode} 画幅`">
                  <option
                    v-for="ratio in SEEDANCE_RATIOS"
                    :key="ratio"
                    :value="ratio"
                    :disabled="
                      !EFFECT_PROMPT_RENDER_CAPABILITIES[
                        draft.settings.capabilityKey
                      ].ratios.includes(ratio)
                    "
                  >
                    {{ ratio === 'adaptive' ? '自适应' : ratio }}
                  </option>
                </select>
              </label>
              <label
                >分辨率
                <select
                  v-model="draft.settings.resolution"
                  :aria-label="`${draft.promptCode} 分辨率`"
                  :aria-invalid="
                    !EFFECT_PROMPT_RENDER_CAPABILITIES[
                      draft.settings.capabilityKey
                    ].resolutions.includes(draft.settings.resolution)
                  "
                >
                  <option
                    v-for="resolution in SEEDANCE_RESOLUTIONS"
                    :key="resolution"
                    :value="resolution"
                    :disabled="
                      !EFFECT_PROMPT_RENDER_CAPABILITIES[
                        draft.settings.capabilityKey
                      ].resolutions.includes(resolution)
                    "
                  >
                    {{ resolution === '4k' ? '4K' : resolution }}
                  </option>
                </select>
              </label>
            </div>
            <p v-if="issues[index]?.length" class="validation-message" role="status">
              {{ issues[index]?.join('；') }}
            </p>
          </section>
        </div>
        <footer>
          <div>
            <p>仅用于本次对应任务，不修改顶部默认配置。</p>
            <span aria-live="polite">已配置 {{ completedCount }} / {{ inputs.length }} 条</span>
          </div>
          <div class="actions">
            <button type="button" @click="emit('cancel')">取消</button
            ><button type="submit" class="primary" :disabled="!valid">使用这些配置</button>
          </div>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.prompt-render-configuration {
  width: min(760px, calc(100vw - 40px));
  max-width: none;
  max-height: calc(100dvh - 48px);
  padding: 0;
  color: #253047;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 16px;
  box-shadow: 0 24px 70px #0f172a38;
  font-family: inherit;
}
.prompt-render-configuration::backdrop {
  background: #0f172a66;
}
form {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 50px);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 24px 26px 20px;
  border-bottom: 1px solid #edf1f7;
}
h2 {
  margin: 0;
  color: #172b4d;
  font-size: 19px;
  font-weight: 650;
}
header p {
  margin: 8px 0 0;
  color: #718096;
  font-size: 13px;
  line-height: 1.6;
}
button,
select {
  font: inherit;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.close {
  display: grid;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  place-items: center;
  padding: 0;
  color: #7b8798;
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.close:hover {
  background: #f3f6fb;
}
.configuration-list {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 26px;
}
.configuration-item {
  padding: 22px 0;
}
.configuration-item + .configuration-item {
  border-top: 1px solid #edf1f7;
}
.item-heading,
.item-heading > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.item-heading {
  justify-content: space-between;
}
.item-heading strong {
  font-size: 14px;
  font-weight: 650;
}
.item-heading span {
  padding: 3px 8px;
  color: #64748b;
  background: #f4f7fb;
  border-radius: 5px;
  font-size: 12px;
}
.apply-all {
  padding: 4px 0;
  color: #2563eb;
  background: none;
  border: 0;
  font-size: 12px;
}
.item-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.prompt-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  color: #2563eb;
  background: none;
  border: 0;
  font-size: 12px;
  white-space: nowrap;
}
.prompt-toggle .expanded {
  transform: rotate(180deg);
}
.prompt-content {
  max-height: 180px;
  overflow-y: auto;
  margin-top: 12px;
  padding: 12px 14px;
  color: #526079;
  background: #f7f9fd;
  border: 1px solid #e6ecf6;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.conflict-reason {
  margin: 8px 0 16px;
  color: #718096;
  font-size: 12px;
  line-height: 1.6;
}
.configuration-fields {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 14px;
}
label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
  color: #526079;
  font-size: 12px;
}
select {
  width: 100%;
  min-width: 0;
  height: 40px;
  padding: 0 10px;
  color: #253047;
  background: #fff;
  border: 1px solid #d5def0;
  border-radius: 8px;
  font-size: 13px;
}
select[aria-invalid='true'] {
  border-color: #d9a35d;
}
button:focus-visible,
select:focus-visible,
.prompt-content:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
.validation-message {
  margin: 10px 0 0;
  color: #a66b22;
  font-size: 12px;
  line-height: 1.6;
}
footer {
  display: flex;
  flex-shrink: 0;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  padding: 18px 26px;
  background: #fbfcfe;
  border-top: 1px solid #edf1f7;
}
footer p {
  margin: 0;
  color: #718096;
  font-size: 12px;
  line-height: 1.6;
}
footer span {
  display: block;
  margin-top: 4px;
  color: #718096;
  font-size: 11px;
}
.actions {
  display: flex;
  flex-shrink: 0;
  gap: 10px;
}
.actions button {
  min-height: 38px;
  padding: 0 16px;
  color: #526079;
  background: #fff;
  border: 1px solid #d5def0;
  border-radius: 8px;
  font-size: 13px;
}
.actions .primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
@media (max-width: 600px) {
  .item-heading {
    flex-wrap: wrap;
    gap: 8px;
  }
  .item-actions {
    width: 100%;
    justify-content: flex-start;
  }
  .prompt-render-configuration {
    width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    border-radius: 12px;
  }
  form {
    max-height: calc(100dvh - 26px);
  }
  header {
    padding: 20px 18px 16px;
  }
  .configuration-list {
    padding: 0 18px;
  }
  .configuration-fields {
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .model-field {
    grid-column: 1 / -1;
  }
  footer {
    align-items: stretch;
    flex-direction: column;
    gap: 14px;
    padding: 16px 18px;
  }
  .actions {
    justify-content: flex-end;
  }
}
</style>
