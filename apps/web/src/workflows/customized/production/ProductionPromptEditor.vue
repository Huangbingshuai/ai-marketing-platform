<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  useId,
  watch,
} from 'vue';
import { Editor, EditorContent } from '@tiptap/vue-3';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { ProductionAsset } from '@ai-marketing/contracts';
import { getAssetVersion } from '../../../platform/asset/api/asset.api';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import { promptMentionRange } from './production-prompt-mentions';
import { promptEditorDocument } from './production-prompt-document';
import { PromptAssetNode } from './production-prompt-node';
const props = defineProps<{
  modelValue: string;
  assets: ProductionAsset[];
  projectId: string;
  scopeId: string;
  readonly?: boolean;
  label?: string;
  placeholder?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; blur: [] }>();
const editor = shallowRef<Editor>();
const menu = ref<HTMLElement>();
const menuPosition = ref({ top: '0px', left: '0px' });
const urls = reactive<Record<string, string>>({});
const range = ref<ReturnType<typeof promptMentionRange>>(null),
  active = ref(0),
  composing = ref(false);
const listId = useId();
const kinds = { CHARACTER: '角色', PRODUCT: '产品', SCENE: '场景', PROP: '道具' };
const order = ['CHARACTER', 'PRODUCT', 'SCENE', 'PROP'];
const options = computed(() =>
  [...props.assets]
    .filter((a) =>
      a.name.toLocaleLowerCase().includes(range.value?.query.trim().toLocaleLowerCase() ?? ''),
    )
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
);
const open = computed(() => !!range.value && !props.readonly && !composing.value);
function locate() {
  if (!editor.value || !editor.value.isFocused || props.readonly || composing.value) {
    range.value = null;
    return;
  }
  const { selection } = editor.value.state;
  const prefix = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    '',
    () => '\ufffc',
  );
  const match = selection.empty ? promptMentionRange(prefix, prefix.length) : null;
  range.value = match
    ? { ...match, start: selection.$from.start() + match.start, end: selection.from }
    : null;
  active.value = 0;
  if (range.value) void nextTick(positionMenu);
}
function positionMenu() {
  if (!open.value || !editor.value || !menu.value) return;
  const caret = editor.value.view.coordsAtPos(editor.value.state.selection.from);
  const container = editor.value.view.dom.closest('.prompt-editor')!.getBoundingClientRect();
  const height = menu.value.offsetHeight;
  const below = caret.bottom + 7;
  const top =
    below + height <= window.innerHeight - 12 ? below : Math.max(12, caret.top - height - 7);
  menuPosition.value = {
    top: `${top - container.top}px`,
    left: `${Math.max(0, Math.min(caret.left - container.left, container.width - menu.value.offsetWidth))}px`,
  };
}
async function choose(asset: ProductionAsset) {
  if (!range.value || props.readonly || !editor.value) return;
  const at = { from: range.value.start, to: range.value.end };
  range.value = null;
  editor.value
    .chain()
    .focus()
    .insertContentAt(at, [{ type: 'promptAsset', attrs: { id: asset.id, label: asset.name } }])
    .run();
  await nextTick();
}
function keydown(event: KeyboardEvent) {
  if (!open.value || event.isComposing || composing.value) return false;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    range.value = null;
    return true;
  }
  if (!options.value.length) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    active.value =
      (active.value + (event.key === 'ArrowDown' ? 1 : -1) + options.value.length) %
      options.value.length;
    void nextTick(() =>
      document.getElementById(`${listId}-${active.value}`)?.scrollIntoView({ block: 'nearest' }),
    );
    return true;
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    void choose(options.value[active.value]!);
    return true;
  }
  return false;
}
function createEditor() {
  range.value = null;
  editor.value?.destroy();
  editor.value = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      PromptAssetNode.configure({ context: { assets: () => props.assets, urls } }),
    ],
    content: promptEditorDocument(props.modelValue, props.assets),
    editable: !props.readonly,
    injectCSS: false,
    editorProps: {
      attributes: editorAttributes(),
      handleKeyDown: (_view, event) => keydown(event),
      handleDOMEvents: {
        compositionstart: () => {
          composing.value = true;
          return false;
        },
        compositionend: () => {
          composing.value = false;
          queueMicrotask(locate);
          return false;
        },
      },
      // Neither pasted HTML nor signed image URLs enter the prompt document.
      handlePaste: (view, event) => {
        if (props.readonly || !event.clipboardData) return false;
        const doc = view.state.schema.nodeFromJSON(
          promptEditorDocument(event.clipboardData.getData('text/plain'), props.assets),
        );
        const slice = Slice.maxOpen(Fragment.from(doc.content));
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
      handleDrop: () => true,
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, '\n', (node) =>
          node.type.name === 'promptAsset' ? `@${node.attrs.label}` : '',
        ),
    },
    onUpdate: ({ editor: current }) => {
      emit('update:modelValue', current.getText({ blockSeparator: '\n' }));
      locate();
    },
    onSelectionUpdate: locate,
    onBlur: () => {
      range.value = null;
      emit('blur');
    },
  });
}
onMounted(() => {
  createEditor();
  window.addEventListener('resize', positionMenu);
  window.addEventListener('scroll', positionMenu, true);
});
onBeforeUnmount(() => editor.value?.destroy());
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionMenu);
  window.removeEventListener('scroll', positionMenu, true);
});
watch(
  () => [props.scopeId, props.projectId],
  () => {
    if (editor.value) createEditor();
  },
);
watch(
  () => props.modelValue,
  (value) => {
    if (editor.value && value !== editor.value.getText({ blockSeparator: '\n' })) createEditor();
  },
);
watch(
  () => props.readonly,
  (value) => {
    editor.value?.setEditable(!value, false);
    editor.value?.setOptions({ editorProps: { attributes: editorAttributes() } });
  },
);
function editorAttributes() {
  return {
    role: 'textbox',
    'aria-label': props.label ?? '分镜视频提示词',
    'aria-multiline': 'true',
    'aria-readonly': String(!!props.readonly),
    'data-placeholder':
      props.placeholder ?? '按当前分镜的完整画面和时间顺序生成提示词；输入 @ 引用素材',
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
    'aria-expanded': String(open.value),
    'aria-controls': open.value ? listId : '',
    'aria-activedescendant': open.value && options.value.length ? `${listId}-${active.value}` : '',
  };
}
watch(
  () => [open.value, active.value, options.value.length],
  () => {
    editor.value?.setOptions({ editorProps: { attributes: editorAttributes() } });
  },
);
let imageController: AbortController | undefined;
watch(
  () => [
    props.projectId,
    props.scopeId,
    props.assets.map((a) => `${a.id}:${a.image?.assetId}:${a.image?.version}`).join('|'),
  ],
  async () => {
    imageController?.abort();
    const controller = new AbortController();
    imageController = controller;
    Object.keys(urls).forEach((id) => delete urls[id]);
    await Promise.all(
      props.assets
        .filter((a) => a.image)
        .map(async (asset) => {
          try {
            const image = asset.image!;
            const response = await getAssetVersion(
              props.projectId,
              image.assetId,
              image.version,
              controller.signal,
            );
            if (imageController === controller && response.data.contentUrl)
              urls[asset.id] = response.data.contentUrl;
          } catch {
            /* A missing preview never changes the reference or prompt. */
          }
        }),
    );
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  imageController?.abort();
  imageController = undefined;
});
watch(
  () => [props.scopeId, props.projectId, props.readonly],
  () => {
    range.value = null;
  },
);
</script>
<template>
  <div class="prompt-editor">
    <EditorContent v-if="editor" :editor="editor" :class="{ readonly }" />
    <div
      v-else
      class="prompt-fallback"
      role="textbox"
      :aria-label="label ?? '分镜视频提示词'"
      aria-readonly="true"
    >
      {{ modelValue }}
    </div>
    <section
      v-if="open"
      ref="menu"
      class="mention-menu"
      :style="menuPosition"
      aria-label="素材引用选择"
    >
      <header>
        <strong>引用素材</strong><span>当前分镜 · {{ assets.length }} 项</span>
      </header>
      <div :id="listId" class="mention-options" role="listbox" aria-label="可引用素材">
        <button
          v-for="(asset, index) in options"
          :id="`${listId}-${index}`"
          :key="asset.id"
          type="button"
          role="option"
          :aria-selected="index === active"
          :aria-label="`引用${asset.name}`"
          :class="{ active: index === active }"
          tabindex="-1"
          @mousedown.prevent
          @mouseenter="active = index"
          @click="choose(asset)"
        >
          <ProductionAssetVisual :asset="asset" :project-id="projectId" compact />
          <span
            ><strong :title="asset.name">{{ asset.name }}</strong
            ><small
              >{{ kinds[asset.kind] }} · {{ asset.image ? '参考图已就绪' : '尚无参考图' }}</small
            ></span
          >
          <span class="mention-mark">@</span>
        </button>
        <p v-if="!options.length">
          {{ assets.length ? '没有匹配的素材' : '请先在参考素材区绑定本镜素材' }}
        </p>
      </div>
      <footer>↑ ↓ 选择 <span>Enter 插入</span><span>Esc 关闭</span></footer>
    </section>
  </div>
</template>
<style scoped>
.prompt-editor {
  position: relative;
  min-width: 0;
  margin-top: 12px;
}
.prompt-editor :deep(.tiptap),
.prompt-fallback {
  box-sizing: border-box;
  width: 100%;
  min-height: 210px;
  border: 1px solid #dce4f1;
  border-radius: 9px;
  padding: 14px;
  font: inherit;
  font-size: 13px;
  line-height: 2.1;
  color: #405674;
  background: #fff;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.prompt-editor :deep(.tiptap:focus) {
  outline: 2px solid #dce6ff;
  border-color: #91acff;
}
.prompt-editor :deep(.tiptap p) {
  margin: 0;
  min-height: 1.9em;
  padding: 0;
  color: inherit;
  font: inherit;
}
.prompt-editor :deep(.tiptap:has(p:only-child > br:only-child))::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  color: #9ba8bb;
  pointer-events: none;
}
.readonly :deep(.tiptap) {
  background: #fafcff;
}
.mention-menu {
  position: absolute;
  z-index: 30;
  width: min(410px, 100%);
  overflow: hidden;
  background: white;
  border: 1px solid #dce4f1;
  border-radius: 12px;
  box-shadow: 0 12px 34px #243c641c;
  color: #405674;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #edf0f5;
  font-size: 12px;
}
header span {
  color: #93a0b4;
  font-size: 11px;
}
.mention-options {
  max-height: min(300px, 40vh);
  overflow: auto;
  padding: 5px;
}
button {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
button.active {
  background: #f0f5ff;
}
button > span:not(.mention-mark) {
  display: grid;
  gap: 5px;
  min-width: 0;
}
button strong {
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button small {
  font-size: 10px;
  color: #91a0b5;
}
.mention-options :deep(.asset-visual) {
  width: 46px;
  height: 36px;
  flex: 0 0 46px;
  border: 1px solid #e6ebf3;
  border-radius: 6px;
}
.mention-mark {
  margin-left: auto;
  color: #9cb0d2;
  font-size: 15px;
}
p {
  padding: 14px;
  color: #8b9ab0;
  font-size: 12px;
}
footer {
  display: flex;
  gap: 14px;
  padding: 9px 14px;
  background: #f8fafd;
  border-top: 1px solid #edf0f5;
  font-size: 10px;
  color: #8b9ab0;
}
</style>
