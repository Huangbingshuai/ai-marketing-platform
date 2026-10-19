export function promptMentionRange(text: string, start: number, end = start) {
  if (start !== end) return null;
  const match = text.slice(0, start).match(/@([^@\n\r，。；：、！？,;:!?“”"（）()]*)$/);
  return match && match[1]!.length <= 80
    ? { start: start - match[0].length, end: start, query: match[1]! }
    : null;
}

export function insertPromptMention(
  text: string,
  range: { start: number; end: number },
  name: string,
) {
  const mention = `@${name} `;
  return {
    text: text.slice(0, range.start) + mention + text.slice(range.end),
    caret: range.start + mention.length,
  };
}
