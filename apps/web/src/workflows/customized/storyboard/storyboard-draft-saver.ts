import type { CustomizedStoryboardDraft } from '@ai-marketing/contracts';
import { snapshotStoryboard, storyboardContentFingerprint } from './storyboard-state';
/** Serialized draft saves: edits arriving during a request are saved in the next pass. */
export function createStoryboardDraftSaver(
  options: {
    snapshot: () => CustomizedStoryboardDraft;
    put: (revision: number | null, draft: CustomizedStoryboardDraft) => Promise<number>;
  },
  revision: number | null,
  initial: CustomizedStoryboardDraft,
) {
  let saved = storyboardContentFingerprint(initial),
    pending: Promise<void> | null = null;
  const dirty = () => saved !== storyboardContentFingerprint(options.snapshot());
  const flush = () => {
    if (pending) return pending;
    pending = (async () => {
      while (dirty()) {
        const value = snapshotStoryboard(options.snapshot()),
          fingerprint = storyboardContentFingerprint(value);
        revision = await options.put(revision, value);
        saved = fingerprint;
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
  return { dirty, flush };
}
