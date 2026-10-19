import type { JSONContent } from '@tiptap/core';
import type { ProductionAsset } from '@ai-marketing/contracts';

/** A view projection only: the authoritative prompt remains plain text. */
export function promptEditorDocument(
  text: string,
  assets: Pick<ProductionAsset, 'id' | 'name'>[],
): JSONContent {
  const candidates = [...assets]
    .filter((a) => a.name)
    .sort((a, b) => b.name.length - a.name.length);
  return {
    type: 'doc',
    content: text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => {
        const content: JSONContent[] = [];
        let cursor = 0;
        for (const at of line.matchAll(/@/g)) {
          const start = at.index!;
          if (start < cursor) continue;
          const asset = candidates.find((a) => line.slice(start + 1).startsWith(a.name));
          if (!asset) continue;
          if (start > cursor) content.push({ type: 'text', text: line.slice(cursor, start) });
          content.push({ type: 'promptAsset', attrs: { id: asset.id, label: asset.name } });
          cursor = start + asset.name.length + 1;
        }
        if (cursor < line.length) content.push({ type: 'text', text: line.slice(cursor) });
        return { type: 'paragraph', content };
      }),
  };
}

export interface PromptMentionImages {
  assets: () => ProductionAsset[];
  urls: Record<string, string>;
}
