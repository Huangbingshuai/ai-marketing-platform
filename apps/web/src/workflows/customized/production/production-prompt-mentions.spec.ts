import { expect, it } from 'vitest';
import { promptMentionRange, insertPromptMention } from './production-prompt-mentions';
it('replaces a caret-local query and keeps Unicode context and the rest of the sentence', () => {
  const text = '😀桌面 @USB，保持构图';
  const range = promptMentionRange(text, 9)!;
  expect(range).toEqual({ start: 5, end: 9, query: 'USB' });
  expect(insertPromptMention(text, range, 'USB-C线')).toEqual({
    text: '😀桌面 @USB-C线 ，保持构图',
    caret: 13,
  });
});
it('does not consume a previous sentence or replace an active selection', () => {
  expect(promptMentionRange('画面@场景。继续', 8)).toBeNull();
  expect(promptMentionRange('@人物', 1, 3)).toBeNull();
  expect(promptMentionRange('@', 1)).toEqual({ start: 0, end: 1, query: '' });
});
