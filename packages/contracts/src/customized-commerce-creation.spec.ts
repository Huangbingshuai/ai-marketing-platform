import { expect, it } from 'vitest';
import fixture from '../fixtures/customized-commerce-creation.json';
import {
  COMMERCE_CREATION_VERSION,
  commerceConcept,
  validateCommerceDevelopment,
  validateCommerceSelection,
  validatePresenterDevelopment,
  type CommerceDevelopment,
} from './customized-commerce-creation';
import {
  storyboardStages,
  validateStoryboardCheckpoint,
  type StoryboardInput,
} from './customized-storyboard-generation';
import { scriptStrategyVersion, isSharedScriptStage } from './customized-script-routes';

const input = fixture.input as unknown as StoryboardInput;
const development = fixture.development as CommerceDevelopment;
it('requires actual presenter strategy fields for the new route, preserving legacy plans', () => {
  const d = structuredClone(development);
  const current = {
    ...input,
    strategyVersions: Object.fromEntries(
      Object.keys(input.strategyVersions!).map((k) => [k, COMMERCE_CREATION_VERSION]),
    ) as NonNullable<StoryboardInput['strategyVersions']>,
  };
  expect(validateStoryboardCheckpoint('ECOMMERCE_MOTIVATION', d, current, '')).toBe(false);
  for (const o of d.opportunities) {
    o.creativeIdea = '用具体观察回答选择疑问';
    o.approach = {
      speaker: '讲述者面对观众',
      recommendation: '从需要解释真实利益',
      speechAndVisual: '自然口播配合产品近景',
    };
  }
  expect(validatePresenterDevelopment(d, input.brief)).toBe(true);
  expect(validateStoryboardCheckpoint('ECOMMERCE_MOTIVATION', d, current, '')).toBe(true);
  const s = structuredClone(fixture.selection);
  s.concepts = s.choices.map((c) =>
    commerceConcept(
      d.opportunities.find((o) => o.id === c.opportunityId)!,
      c.scriptId,
    ),
  );
  expect(validateCommerceSelection(s, d, input.scriptIds)).toBe(true);
  expect(s.concepts[0]!.coreIdea).toBe(d.opportunities[0]!.creativeIdea);
  d.opportunities[0]!.approach!.speaker = ' ';
  expect(validatePresenterDevelopment(d, input.brief)).toBe(false);
});
it('validates cross-process motivation, demonstration and selected original plans', () => {
  expect(validateCommerceDevelopment(development, input.brief)).toBe(true);
  expect(validateCommerceSelection(fixture.selection, development, input.scriptIds)).toBe(true);
  expect(fixture.selection.concepts[0]).toEqual(
    commerceConcept(development.opportunities[0]!, input.scriptIds[0]!),
  );
});
it.each(['fact', 'duplicate', 'missing', 'basis'])('rejects invalid opportunity %s', (which) => {
  const d = structuredClone(development);
  if (which === 'fact') d.opportunities[0]!.factIds = ['foreign'];
  if (which === 'duplicate') d.opportunities[1]!.id = d.opportunities[0]!.id;
  if (which === 'missing') d.opportunities[0]!.demonstration.observableResult = '';
  if (which === 'basis') d.opportunities[0]!.situationBasis = 'REAL_SURVEY' as never;
  expect(validateCommerceDevelopment(d, input.brief)).toBe(false);
});
it.each(['identity', 'rejected', 'coverage', 'projection', 'readiness'])(
  'rejects forged selection %s',
  (which) => {
    const s = structuredClone(fixture.selection);
    if (which === 'identity') s.choices[0]!.scriptId = 'foreign';
    if (which === 'rejected') s.evaluations[0]!.verdict = 'REJECT';
    if (which === 'coverage') s.evaluations.pop();
    if (which === 'projection') s.concepts[0]!.plan.buyingReason = 'invented';
    if (which === 'readiness') s.readiness.status = 'NEEDS_INFORMATION';
    expect(validateCommerceSelection(s, development, input.scriptIds)).toBe(false);
  },
);
it('freezes the commerce graph without changing old commerce or current brand routes', () => {
  expect(scriptStrategyVersion('ECOMMERCE')).toBe(COMMERCE_CREATION_VERSION);
  expect(scriptStrategyVersion('BRAND_AD')).toBe('2026-10-14.7');
  expect(storyboardStages(input).map((s) => s.id)).toContain('ECOMMERCE_MOTIVATION');
  const old = {
    ...input,
    strategyVersions: Object.fromEntries(
      Object.keys(input.strategyVersions!).map((k) => [k, '2026-10-14.7']),
    ) as NonNullable<StoryboardInput['strategyVersions']>,
  };
  expect(storyboardStages(old).map((s) => s.id)).not.toContain('ECOMMERCE_MOTIVATION');
  expect(isSharedScriptStage('ECOMMERCE_MOTIVATION')).toBe(true);
  expect(validateStoryboardCheckpoint('ECOMMERCE_MOTIVATION', development, input, '')).toBe(true);
  expect(
    validateStoryboardCheckpoint(
      'ECOMMERCE_REVIEW',
      { summary: '通过', findings: [] },
      input,
      's0',
    ),
  ).toBe(false);
});
it('represents missing product evidence without producing invented plans', () => {
  const d = {
    readiness: { status: 'NEEDS_INFORMATION', reason: '产品特点缺失', missing: ['产品特点'] },
    opportunities: [],
  };
  expect(validateCommerceDevelopment(d, input.brief)).toBe(true);
  expect(
    validateCommerceDevelopment({ ...d, opportunities: development.opportunities }, input.brief),
  ).toBe(false);
});
it('keeps shared readiness text limits without accepting blank reasons or overlong script names', () => {
  const d = structuredClone(development);
  d.readiness.reason = '完整资料依据'.repeat(100);
  expect(validateCommerceDevelopment(d, input.brief)).toBe(true);
  d.readiness.reason = ' ';
  expect(validateCommerceDevelopment(d, input.brief)).toBe(false);
  d.readiness.reason = '资料充分';
  d.opportunities[0]!.name = '名'.repeat(201);
  expect(validateCommerceDevelopment(d, input.brief)).toBe(false);
});
