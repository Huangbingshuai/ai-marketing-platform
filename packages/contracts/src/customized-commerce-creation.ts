import type { CustomizedBrief } from './customized-extraction';
import { brandFactCatalog } from './customized-brand-creation';

export const COMMERCE_CREATION_VERSION = '2026-10-14-presenter.3';
export const PRESENTER_CREATION_VERSIONS: readonly string[] = ['2026-10-14-presenter.1', '2026-10-14-presenter.2', COMMERCE_CREATION_VERSION];
export const COMMERCE_CREATION_VERSIONS: readonly string[] = ['2026-10-14-commerce.1', '2026-10-14-commerce.2', '2026-10-14-commerce.3', '2026-10-14-commerce.4', '2026-10-14-commerce.5', ...PRESENTER_CREATION_VERSIONS];
export const isCommerceStrategy = (version: string | undefined) => COMMERCE_CREATION_VERSIONS.includes(version ?? '');
export const isPresenterStrategy = (version: string | undefined) => PRESENTER_CREATION_VERSIONS.includes(version ?? '');
export const PRESENTER_APPROACH_FIELDS = { speaker: '讲述者与口吻', recommendation: '推荐逻辑', speechAndVisual: '讲述与演示分工' } as const;
export type CommerceOpportunity = {
  id: string;
  name: string;
  audienceSituation: string;
  situationBasis: 'BRIEF' | 'CREATIVE_HYPOTHESIS';
  buyingReason: string;
  purchaseQuestion: string;
  factIds: string[];
  demonstration: { setup: string; action: string; observableResult: string; claimBoundary: string };
  progression: string;
  ending: string;
  creativeIdea?: string;
  approach?: Record<keyof typeof PRESENTER_APPROACH_FIELDS, string>;
};
export type CommerceDevelopment = {
  readiness: { status: 'READY' | 'NEEDS_INFORMATION'; reason: string; missing: string[] };
  opportunities: CommerceOpportunity[];
};
export type CommerceChoice = { scriptId: string; opportunityId: string; mustPreserve: string[] };
export type CommerceSelection = {
  status: 'READY' | 'REWORK' | 'NEEDS_INFORMATION';
  reason: string;
  missing: string[];
  evaluations: { opportunityId: string; verdict: 'ADVANCE' | 'REJECT'; reason: string }[];
  choices: CommerceChoice[];
};
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 240;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const missing = (v: unknown): v is string[] => strings(v) && v.length <= 20 && v.every(s => s.length <= 200);
const reason = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 20000;
export function validateCommerceDevelopment(value: unknown, brief: CustomizedBrief): value is CommerceDevelopment {
  if (!obj(value) || !obj(value.readiness) || !reason(value.readiness.reason) ||
      !missing(value.readiness.missing) || !Array.isArray(value.opportunities)) return false;
  if (value.readiness.status === 'NEEDS_INFORMATION')
    return value.readiness.missing.length > 0 && !value.opportunities.length;
  if (value.readiness.status !== 'READY' || value.readiness.missing.length || value.opportunities.length !== 6) return false;
  const facts = new Set(brandFactCatalog(brief).map(f => f.id));
  return new Set(value.opportunities.map(v => obj(v) ? v.id : null)).size === 6 &&
    value.opportunities.every(v => obj(v) &&
      ['id', 'name', 'audienceSituation', 'buyingReason', 'purchaseQuestion', 'progression', 'ending'].every(k => text(v[k])) &&
      String(v.name).length <= 200 &&
      ['BRIEF', 'CREATIVE_HYPOTHESIS'].includes(String(v.situationBasis)) &&
      strings(v.factIds) && v.factIds.length > 0 && v.factIds.length <= 30 && v.factIds.every(id => facts.has(id)) &&
      obj(v.demonstration) && ['setup', 'action', 'observableResult', 'claimBoundary'].every(k => text((v.demonstration as Record<string, unknown>)[k])));
}
export function validatePresenterDevelopment(value: unknown, brief: CustomizedBrief): value is CommerceDevelopment {
  return validateCommerceDevelopment(value, brief) && value.opportunities.every(o =>
    text(o.creativeIdea) && obj(o.approach) && Object.keys(o.approach).length === 3 &&
    Object.keys(PRESENTER_APPROACH_FIELDS).every(k => text((o.approach as Record<string, unknown>)[k])));
}
/** Preserve the author's selected plan; this mapping creates no semantic content. */
export function commerceConcept(opportunity: CommerceOpportunity, scriptId: string) {
  const d = opportunity.demonstration;
  return {
    scriptId, name: opportunity.name, synopsis: `${d.setup}\n${d.action}\n${d.observableResult}`,
    productFocus: opportunity.buyingReason, structure: opportunity.progression,
    difference: opportunity.creativeIdea ? `${opportunity.purchaseQuestion}\n${opportunity.creativeIdea}` : opportunity.purchaseQuestion,
    coreIdea: opportunity.creativeIdea ?? opportunity.buyingReason,
    openingHook: d.setup, productRole: d.action, memoryPoint: d.observableResult,
    plan: { videoType: 'ECOMMERCE' as const, buyingReason: opportunity.buyingReason,
      audienceSituation: opportunity.audienceSituation,
      demonstration: `${d.setup}\n${d.action}\n${d.observableResult}\n表达边界：${d.claimBoundary}`,
      progression: opportunity.progression, ending: opportunity.ending },
  };
}
export function validateCommerceSelection(
  value: unknown, development: CommerceDevelopment, scriptIds: string[],
): boolean {
  if (!obj(value) || !['READY', 'REWORK', 'NEEDS_INFORMATION'].includes(String(value.status)) ||
      !text(value.reason) || !missing(value.missing) || !Array.isArray(value.evaluations) ||
      !Array.isArray(value.choices) || !Array.isArray(value.concepts) || !obj(value.readiness) ||
      value.readiness.status !== (value.status === 'READY' ? 'READY' : 'NEEDS_INFORMATION') ||
      value.readiness.reason !== value.reason || JSON.stringify(value.readiness.missing) !== JSON.stringify(value.missing)) return false;
  const opportunities = new Map(development.opportunities.map(v => [v.id, v]));
  if (value.evaluations.length !== opportunities.size ||
      new Set(value.evaluations.map(v => obj(v) ? v.opportunityId : null)).size !== opportunities.size ||
      !value.evaluations.every(v => obj(v) && opportunities.has(String(v.opportunityId)) &&
        ['ADVANCE', 'REJECT'].includes(String(v.verdict)) && text(v.reason))) return false;
  if (value.status !== 'READY') return !value.choices.length && !value.concepts.length &&
    (value.status !== 'NEEDS_INFORMATION' || value.missing.length > 0);
  if (development.readiness.status !== 'READY' || value.missing.length ||
      value.choices.length !== scriptIds.length || value.concepts.length !== scriptIds.length ||
      new Set(value.choices.map(v => obj(v) ? v.scriptId : null)).size !== scriptIds.length ||
      new Set(value.choices.map(v => obj(v) ? v.opportunityId : null)).size !== scriptIds.length ||
      new Set(value.concepts.map(v => obj(v) ? v.scriptId : null)).size !== scriptIds.length) return false;
  const evaluations = value.evaluations, concepts = value.concepts;
  return value.choices.every(choice => {
    if (!obj(choice) || !scriptIds.includes(String(choice.scriptId)) || !strings(choice.mustPreserve) ||
        choice.mustPreserve.length < 2 || choice.mustPreserve.length > 4) return false;
    const opportunity = opportunities.get(String(choice.opportunityId));
    if (!opportunity || !evaluations.some(e => obj(e) && e.opportunityId === opportunity.id && e.verdict === 'ADVANCE')) return false;
    const expected = commerceConcept(opportunity, String(choice.scriptId));
    const concept = concepts.find(c => obj(c) && c.scriptId === choice.scriptId);
    return obj(concept) && obj(concept.plan) && Object.entries(expected).every(([key, expectedValue]) =>
      key === 'plan' ? Object.entries(expected.plan).every(([k, v]) => (concept.plan as Record<string, unknown>)[k] === v) : concept[key] === expectedValue);
  });
}
