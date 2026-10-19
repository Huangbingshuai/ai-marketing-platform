import { describe, expect, it } from 'vitest';
import { getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, undo, redo } from '@tiptap/pm/history';
import { Slice } from '@tiptap/pm/model';
import { PromptAssetNode } from './production-prompt-node';
import { promptEditorDocument } from './production-prompt-document';
const assets = [
  { id: 'cup', name: '杯' },
  { id: 'tray', name: '杯托' },
];
const schema = getSchema([Document, Paragraph, Text, PromptAssetNode]);
const parse = (text: string) => schema.nodeFromJSON(promptEditorDocument(text, assets));
const plain = (doc: ReturnType<typeof parse>) =>
  getText(doc, { blockSeparator: '\n', textSerializers: getTextSerializersFromSchema(schema) });

describe('plain prompt with inline asset nodes', () => {
  it('round trips whitespace, empty lines, Unicode and repeated longest-name references exactly', () => {
    const source = '  😀@杯托的特写；@杯\n\n0–3秒：@杯托。\n';
    const doc = parse(source);
    expect(plain(doc)).toBe(source);
    const ids: string[] = [];
    doc.descendants((node) => {
      if (node.type.name === 'promptAsset') ids.push(node.attrs.id);
    });
    expect(ids).toEqual(['tray', 'cup', 'tray']);
  });
  it('keeps unknown and incomplete references as editable plain text', () => {
    const source = '@未知素材；@\n@杯托';
    expect(plain(parse(source))).toBe(source);
    expect(parse(source).firstChild!.firstChild!.isText).toBe(true);
  });
  it('does not interpret pasted HTML or image URLs as rich input', () => {
    const source = '<img src="https://example.test/x"> @杯';
    const doc = parse(source);
    expect(plain(doc)).toBe(source);
    expect(doc.toJSON().content[0].content[0].type).toBe('text');
  });
  it('serializes clipboard slices to the original @name without internal IDs or images', () => {
    const doc = parse('使用@杯托\n再次@杯');
    const slice = Slice.maxOpen(doc.content);
    expect(
      slice.content.textBetween(0, slice.content.size, '\n', (node) =>
        node.type.name === 'promptAsset' ? `@${node.attrs.label}` : '',
      ),
    ).toBe('使用@杯托\n再次@杯');
    expect(doc.firstChild!.child(1).nodeSize).toBe(1);
  });
  it('deletes an entire token and supports undo/redo without losing adjacent text', () => {
    let state = EditorState.create({ schema, doc: parse('前@杯托后'), plugins: [history()] });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)).delete(2, 3));
    expect(plain(state.doc)).toBe('前后');
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(plain(state.doc)).toBe('前@杯托后');
    redo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(plain(state.doc)).toBe('前后');
  });
});
