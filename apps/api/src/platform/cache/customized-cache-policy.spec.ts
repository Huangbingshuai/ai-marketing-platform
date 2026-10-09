import { describe, expect, it } from 'vitest';
import { canCacheCustomizedProjection as cacheable } from './customized-cache-policy';

const draft = {
  nodeId: 'SOURCE_IMPORT',
  createdAt: '2026-10-09',
  state: {
    schemaVersion: 3,
    requirements: '',
    materials: [
      { assetId: '77777777-7777-4777-8777-777777777777', assetVersion: 2, category: 'BRIEF' },
    ],
  },
};
describe('customized cache payload boundary', () => {
  it('allows pinned file references and import-only overviews', () => {
    expect(cacheable('customized-import-draft', draft)).toBe(true);
    expect(
      cacheable('customized-overview', {
        run: { workflow: 'CUSTOMIZED', workflowSpace: 'CUSTOMIZED_PROJECT' },
        nodeStates: [draft],
      }),
    ).toBe(true);
  });
  it.each([
    { ...draft, state: { ...draft.state, requirements: 'body' } },
    {
      ...draft,
      state: {
        schemaVersion: 2,
        customerRequirements: 'body',
        productInformation: 'body',
        materials: [],
      },
    },
    { ...draft, state: { ...draft.state, rawText: 'body' } },
    {
      ...draft,
      state: { ...draft.state, materials: [{ ...draft.state.materials[0], body: 'text' }] },
    },
    { ...draft, payload: { documentText: 'body' } },
    { ...draft, nodeId: 'INFORMATION_EXTRACTION' },
  ])('bypasses raw/unknown state in both draft and mixed overview: %j', (state) => {
    expect(cacheable('customized-import-draft', state)).toBe(false);
    expect(
      cacheable('customized-overview', {
        run: { workflow: 'CUSTOMIZED', workflowSpace: 'CUSTOMIZED_PROJECT' },
        nodeStates: [state],
      }),
    ).toBe(false);
  });
});
