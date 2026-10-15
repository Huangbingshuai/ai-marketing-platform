import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  restorationVariants,
  repairedDeletionRuns,
  orderedSnapshotItems,
} from './recover-deleted-mix-template.mjs';
const item = () => ({
  variantId: 'v',
  snapshot: {
    variant: {
      id: 'v',
      slots: [{ id: 's' }],
      bindings: { s: 'a' },
      bindingRevisions: { s: 2 },
      bindingSources: {
        s: {
          artifactId: 'a',
          artifactKey: 'render-clip:p',
          artifactRevision: 2,
          artifactContentHash: 'h',
          fileObjectId: 'f',
          contentHash: 'bytes',
        },
      },
    },
    clips: [{ slotId: 's', materialId: 'a', fileObjectId: 'f', contentHash: 'bytes' }],
  },
});
test('preserves numbered film presentation order rather than random database UUID order', () => {
  const items = [10, 2, 1].map((n) => ({
    variantId: `v-${n}`,
    snapshot: { variant: { name: `测试2 · ${n}` } },
  }));
  assert.deepEqual(
    orderedSnapshotItems(items, (i) => i.snapshot).map((i) => i.variantId),
    ['v-1', 'v-2', 'v-10'],
  );
  assert.equal(items[0].variantId, 'v-10');
});
test('restores frozen adoption, not current upstream revisions, without mutating the input', () => {
  const source = item(),
    restored = restorationVariants([source], (i) => i.snapshot);
  assert.equal(restored[0].bindingRevisions.s, 2);
  restored[0].bindings.s = 'other';
  assert.equal(source.snapshot.variant.bindings.s, 'a');
});
test('rejects guessed source identity, file mismatch and duplicate variants', () => {
  const source = item();
  source.snapshot.variant.bindingSources.s.fileObjectId = 'wrong';
  assert.throws(() => restorationVariants([source], (i) => i.snapshot), /UNPROVEN/);
  assert.throws(() => restorationVariants([item(), item()], (i) => i.snapshot), /INVALID/);
  const missing = item();
  delete missing.snapshot.variant.bindingSources;
  assert.throws(() => restorationVariants([missing], (i) => i.snapshot), /UNPROVEN/);
});
test('removes only verified foreign Runs and preserves the intended deletion', () => {
  assert.deepEqual(repairedDeletionRuns(['a', 'b', 'c'], ['b', 'c']), ['a']);
  assert.throws(() => repairedDeletionRuns(['a'], ['b']), /RECEIPT_CHANGED/);
  assert.throws(() => repairedDeletionRuns(['a'], []), /RECEIPT_CHANGED/);
});
