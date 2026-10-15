import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { recoveredImportSnapshot, recoveryBatchInclude } from './recover-effect-imported-materials.mjs';

test('uses the normal render repository order for stable confirmed pool fingerprints', () => {
  assert.deepEqual(recoveryBatchInclude.tasks.orderBy, [{ renderCode: 'asc' }, { id: 'asc' }]);
});

test('keeps the confirmed imported content while rebinding only upstream context', () => {
  const source = { projectId: 'p', workflowRunId: 'history', productId: 'old', productName: 'n',
    sourcePrompt: { artifactId: 'old-prompt' }, sourcePackage: { artifactId: 'old-source' },
    promptId: 'stable-import', promptText: 'saved imported description', importedMaterial: { width: 720 },
    request: { duration: 6.041667 }, outputDurationSeconds: 6.041667,
    refreshContext: {}, adoptedInput: {}, inputVideo: {}, repair: {} };
  const target = { projectId: 'p', workflowRunId: 'root', productId: 'current', productName: 'n',
    sourcePrompt: { artifactId: 'current-prompt' }, sourcePackage: { artifactId: 'current-source' } };
  const result = recoveredImportSnapshot(source, target);
  assert.equal(result.workflowRunId, 'root');
  assert.equal(result.promptId, 'stable-import');
  assert.equal(result.promptText, source.promptText);
  assert.equal(result.outputDurationSeconds, source.outputDurationSeconds);
  assert.deepEqual(result.sourcePackage, target.sourcePackage);
  assert.equal('refreshContext' in result, false);
  assert.equal(source.workflowRunId, 'history');
});

test('cannot recover an AI candidate as an imported material', () => {
  assert.throws(() => recoveredImportSnapshot({}, {}), /REQUIRES_EXTERNAL_IMPORT/);
});
