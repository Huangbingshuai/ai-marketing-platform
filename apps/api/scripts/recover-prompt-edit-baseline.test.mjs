import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebasePromptItems } from './recover-prompt-edit-baseline.mjs';

const item = (id, code, content = id) => ({ id, code, content });
test('keeps adopted edits and additions while replaying exactly the user delta', () => {
  const base = [item('a', 'P001'), item('b', 'P002'), item('c', 'P003')];
  const adopted = [
    item('a', 'P001', 'newer'),
    base[1],
    base[2],
    item('d', 'P004'),
    item('e', 'P005'),
  ];
  const saved = [base[0], item('c', 'P003', 'user edit'), item('f', 'P004')];
  const result = rebasePromptItems(base, saved, adopted);
  assert.deepEqual(result.items, [adopted[0], saved[1], adopted[3], adopted[4], item('f', 'P006')]);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.edited.length, 1);
  assert.equal(result.added.length, 1);
});
test('refuses overlapping edits, deletes and duplicate identities', () => {
  const base = [item('a', 'P001')];
  assert.throws(
    () => rebasePromptItems(base, [item('a', 'P001', 'user')], [item('a', 'P001', 'other')]),
    /Concurrent/,
  );
  assert.throws(() => rebasePromptItems(base, [], [item('a', 'P001', 'other')]), /Concurrent/);
  assert.throws(() => rebasePromptItems(base, [], [...base, ...base]), /Duplicate/);
});
test('preserves cumulative additions across two saves before rendering', () => {
  const adopted = [item('a', 'P001')];
  const first = rebasePromptItems(adopted, [...adopted, item('b', 'P002')], adopted).items;
  const second = rebasePromptItems(first, [...first, item('c', 'P003')], first).items;
  assert.deepEqual(
    second.filter((item) => !adopted.some(({ id }) => id === item.id)).map(({ code }) => code),
    ['P002', 'P003'],
  );
});
