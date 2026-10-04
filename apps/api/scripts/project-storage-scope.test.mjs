import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStorageKey, projectStorageOwner } from './project-storage-scope.mjs';
const keep = '40d1273a-e1cd-4cae-8f83-02fdaf324dc1';
const other = '3118f93a-5909-48d4-8edc-d374f135be3f';
const projects = [
  { id: keep, name: '紫苏梅子酱' },
  { id: other, name: '测试-紫苏梅子酱' },
];
test('uses stable IDs and not similar project names', () => {
  assert.equal(projectStorageOwner('projects/紫苏梅子酱__40d1273a/file.mp4', projects), keep);
  assert.equal(
    classifyStorageKey('projects/测试-紫苏梅子酱__3118f93a/file.mp4', keep, projects, new Map()),
    'DELETE',
  );
  assert.equal(
    classifyStorageKey('projects/紫苏梅子酱/file.mp4', keep, projects, new Map()),
    'UNKNOWN',
  );
});
test('retained references and shared files are always protected', () => {
  const key = 'projects/测试-紫苏梅子酱__3118f93a/file.mp4';
  assert.equal(
    classifyStorageKey(key, keep, projects, new Map([[key, new Set([other, keep])]])),
    'KEEP',
  );
  assert.equal(
    classifyStorageKey('shared/effect-voices/vivi/demo.wav', keep, projects, new Map()),
    'KEEP',
  );
});
test('ambiguous ID prefixes are rejected instead of selecting a project', () => {
  assert.throws(
    () =>
      projectStorageOwner(
        'projects/test__40d1273a/file',
        projects.concat({ id: '40d1273a-1111-4111-8111-111111111111' }),
      ),
    { code: 'AMBIGUOUS_PROJECT_PREFIX' },
  );
});
test('unknown ownership is not a deletion candidate', () => {
  assert.equal(
    classifyStorageKey('projects/unknown__ffffffff/file', keep, projects, new Map()),
    'UNKNOWN',
  );
});
