import { computed, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectFinalOutputNodePage.vue?raw';

function available(fields: Record<string, unknown>) {
  const run = ref({ projectChanges: { added: [{ variantId: 'new' }] }, counts: { stale: 2 },
    items: [{ fileObjectId: 'old-file', assetId: 'old-asset' }], ...fields });
  const source = `const canLocalUpdate =${page.split('const canLocalUpdate =')[1]!.split('const pageCount =')[0]!}`;
  const js = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function('computed', 'run', `${js}; return canLocalUpdate.value;`)(computed, run);
}

describe('local output update with appended pending films', () => {
  it('offers one local update for modified deliveries and appended films', () => {
    expect(available({ status: 'PENDING_RENDER' })).toBe(true);
  });
  it.each(['QUEUED', 'RUNNING'])('does not offer another update during %s', (status) => {
    expect(available({ status })).toBe(false);
  });
  it('keeps the first unexported batch on the normal export path', () => {
    expect(available({ status: 'PENDING_RENDER', items: [{ fileObjectId: null, assetId: null }] })).toBe(false);
  });
  it('does not offer an update for unchanged files', () => {
    expect(available({ status: 'COMPLETED', counts: { stale: 0 } })).toBe(false);
  });
});
