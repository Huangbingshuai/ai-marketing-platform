import { Node } from '@tiptap/core';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import ProductionPromptMention from './ProductionPromptMention.vue';
import type { PromptMentionImages } from './production-prompt-document';

export const PromptAssetNode = Node.create<{ context: PromptMentionImages }>({
  name: 'promptAsset',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: false,
  addOptions: () => ({ context: { assets: () => [], urls: {} } }),
  addAttributes: () => ({ id: { default: '' }, label: { default: '' } }),
  // HTML is never accepted as authoritative input or sent to the API.
  renderHTML: ({ node }) => [
    'span',
    { 'data-prompt-asset': node.attrs.id },
    `@${node.attrs.label}`,
  ],
  renderText: ({ node }) => `@${node.attrs.label}`,
  addNodeView: () => VueNodeViewRenderer(ProductionPromptMention),
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { selection } = this.editor.state;
        return selection.empty && selection.$from.nodeBefore?.type === this.type
          ? this.editor.commands.deleteRange({ from: selection.from - 1, to: selection.from })
          : false;
      },
      Delete: () => {
        const { selection } = this.editor.state;
        return selection.empty && selection.$from.nodeAfter?.type === this.type
          ? this.editor.commands.deleteRange({ from: selection.from, to: selection.from + 1 })
          : false;
      },
    };
  },
});
