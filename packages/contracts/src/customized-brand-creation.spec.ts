import { expect, it } from 'vitest';
import fixture from '../fixtures/customized-brand-creation.json';
import {
  brandFactCatalog,
  validateBrandDevelopment,
  validateBrandSelection,
} from './customized-brand-creation';
import {
  storyboardStages,
  storyboardProgress,
  type StoryboardInput,
} from './customized-storyboard-generation';

const input = fixture.input as unknown as StoryboardInput;
it('keeps the new brand graph scoped to its frozen version and progress weights', () => {
  const stages = storyboardStages(input);
  expect(stages.map((s) => s.id)).toContain('BRAND_AD_PROPOSITION');
  expect(stages.map((s) => s.id)).toContain('BRAND_AD_IDEAS');
  expect(stages.reduce((sum, s) => sum + s.weight, 0)).toBe(100);
  expect(
    storyboardProgress(
      stages.map((s) => ({ nodeId: s.id, scriptId: '', status: 'SUCCEEDED' })),
      ['s0'],
      false,
      true,
      input,
    ),
  ).toBeLessThan(100);
  const old = {
    ...input,
    strategyVersions: {
      concept: '2026-10-13.11',
      story: '2026-10-13.11',
      review: '2026-10-13.11',
      repair: '2026-10-13.11',
    },
  };
  expect(storyboardStages(old).map((s) => s.id)).not.toContain('BRAND_AD_PROPOSITION');
});
it('validates all candidate evaluations, script bindings and actual fact references', () => {
  expect(validateBrandDevelopment(fixture.development, input.brief, 6)).toBe(true);
  expect(
    validateBrandSelection(fixture.selection, fixture.development, input.scriptIds, input.brief),
  ).toBe(true);
  const tampered = structuredClone(fixture.selection);
  tampered.commitments[0]!.essentialFactIds = ['foreign'];
  expect(validateBrandSelection(tampered, fixture.development, input.scriptIds, input.brief)).toBe(
    false,
  );
  tampered.commitments[0]!.essentialFactIds = ['F01'];
  tampered.commitments[0]!.ideaId = 'foreign';
  expect(validateBrandSelection(tampered, fixture.development, input.scriptIds, input.brief)).toBe(
    false,
  );
  tampered.commitments[0]!.ideaId = 'C01';
  tampered.evaluations.pop();
  expect(validateBrandSelection(tampered, fixture.development, input.scriptIds, input.brief)).toBe(
    false,
  );
});
it('does not change fact identities with object key order', () => {
  const reversed = Object.fromEntries(Object.entries(input.brief).reverse()) as typeof input.brief;
  expect(brandFactCatalog(reversed)).toEqual(brandFactCatalog(input.brief));
});
