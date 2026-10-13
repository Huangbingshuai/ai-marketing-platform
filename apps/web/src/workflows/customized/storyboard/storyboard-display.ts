import type { CustomizedStoryboardAsset } from '@ai-marketing/contracts';

/** Read-only labels; never serialize these replacements back into the script draft. */
export function storyboardObjectDescription(
  text: string,
  assets: CustomizedStoryboardAsset[] = [],
): string {
  let result = text;
  for (const asset of [...assets].sort((a, b) => b.id.length - a.id.length)) {
    if (!asset.id || !asset.name) continue;
    result = result.replace(
      new RegExp(
        `(?<![A-Za-z0-9_-])${asset.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`,
        'g',
      ),
      () => asset.name,
    );
  }
  return result;
}
