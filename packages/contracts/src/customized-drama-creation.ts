import type { CustomizedBrief } from './customized-extraction';
import type { ScriptCreativePlan, ScriptReadiness } from './customized-script-routes';
import { brandFactCatalog } from './customized-brand-creation';

export const DRAMA_CREATION_VERSION = '2026-10-14-drama.3';
export const DRAMA_CREATION_VERSIONS: readonly string[] = ['2026-10-14-drama.1', '2026-10-14-drama.2', DRAMA_CREATION_VERSION];
export const isDramaStrategy = (version: string | undefined) => DRAMA_CREATION_VERSIONS.includes(version ?? '');
export const DRAMA_DEVELOPMENT_FIELDS = {
  viewingPromise: '观众想看到的答案', informationDesign: '信息揭示安排',
  dialogueIntent: '对白交往目的', emotionalMovement: '情绪变化', weakness: '需警惕的问题',
} as const;
export type DramaIdea = {
  id: string; name: string; devices: string[];
  plan: Extract<ScriptCreativePlan, { videoType: 'DRAMA' }>;
  viewingPromise: string; informationDesign: string; dialogueIntent: string;
  emotionalMovement: string; factIds: string[]; weakness: string;
};
export type DramaDevelopment = { readiness: ScriptReadiness; ideas: DramaIdea[] };
export type DramaSelection = {
  status: 'READY' | 'REWORK' | 'NEEDS_INFORMATION'; reason: string; missing: string[];
  evaluations: { ideaId: string; verdict: 'ADVANCE' | 'REJECT'; reason: string }[];
  choices: { scriptId: string; ideaId: string; mustPreserve: string[] }[];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 240;
const id = (v: unknown): v is string => text(v) && v.length <= 200;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const planFields = ['desire','obstacle','relationships','trigger','escalation','choice','consequence','productCausality'] as const;
export function validateDramaDevelopment(value: unknown, brief: CustomizedBrief, scriptCount: number): value is DramaDevelopment {
  if (!object(value) || !object(value.readiness) || typeof value.readiness.reason !== 'string' ||
      !value.readiness.reason.trim() || value.readiness.reason.length > 20000 ||
      !Array.isArray(value.readiness.missing) || value.readiness.missing.length > 20 ||
      !value.readiness.missing.every(id) || !Array.isArray(value.ideas)) return false;
  if (value.readiness.status === 'NEEDS_INFORMATION') return !!value.readiness.missing.length && !value.ideas.length;
  const count = Math.min(7, scriptCount + 2), known = new Set(brandFactCatalog(brief).map(f => f.id));
  return value.readiness.status === 'READY' && !value.readiness.missing.length && value.ideas.length === count &&
    new Set(value.ideas.map(v => object(v) ? v.id : null)).size === count &&
    new Set(value.ideas.map(v => object(v) ? v.name : null)).size === count && value.ideas.every(v =>
      object(v) && id(v.id) && id(v.name) && Object.keys(DRAMA_DEVELOPMENT_FIELDS).every(k => text(v[k])) &&
      texts(v.devices) && v.devices.length >= 1 && v.devices.length <= 3 &&
      object(v.plan) && v.plan.videoType === 'DRAMA' && planFields.every(k => text((v.plan as Record<string, unknown>)[k])) &&
      Array.isArray(v.factIds) && v.factIds.length >= 1 && v.factIds.length <= 30 && v.factIds.every(ref => id(ref) && known.has(ref)));
}
export function dramaConcept(idea: DramaIdea, scriptId: string) {
  const p = idea.plan;
  return { scriptId, name: idea.name, synopsis: `${p.trigger}\n${p.escalation}\n${p.consequence}`,
    structure: `${p.trigger}\n${p.choice}\n${p.consequence}`, productFocus: p.productCausality,
    difference: `${idea.devices.join('、')}\n${idea.informationDesign}`, coreIdea: idea.viewingPromise,
    openingHook: p.trigger, productRole: p.productCausality, memoryPoint: p.consequence, plan: { ...p } };
}
export function validateDramaSelection(value: unknown, development: DramaDevelopment, scriptIds: string[]): boolean {
  if (!object(value) || !['READY','REWORK','NEEDS_INFORMATION'].includes(String(value.status)) || !text(value.reason) ||
      !Array.isArray(value.missing) || value.missing.length > 20 || !value.missing.every(id) ||
      !Array.isArray(value.evaluations) || !Array.isArray(value.choices) || !Array.isArray(value.concepts) ||
      !object(value.readiness) || value.readiness.status !== (value.status === 'READY' ? 'READY' : 'NEEDS_INFORMATION') ||
      value.readiness.reason !== value.reason || JSON.stringify(value.readiness.missing) !== JSON.stringify(value.missing)) return false;
  const ideas = new Map(development.ideas.map(i => [i.id, i]));
  if (value.evaluations.length !== ideas.size || new Set(value.evaluations.map(e => object(e) ? e.ideaId : null)).size !== ideas.size ||
      !value.evaluations.every(e => object(e) && ideas.has(String(e.ideaId)) && ['ADVANCE','REJECT'].includes(String(e.verdict)) && text(e.reason))) return false;
  if (value.status !== 'READY') return !value.choices.length && !value.concepts.length && (value.status !== 'NEEDS_INFORMATION' || !!value.missing.length);
  if (development.readiness.status !== 'READY' || value.missing.length || value.choices.length !== scriptIds.length ||
      value.concepts.length !== scriptIds.length || new Set(value.choices.map(c => object(c) ? c.scriptId : null)).size !== scriptIds.length ||
      new Set(value.choices.map(c => object(c) ? c.ideaId : null)).size !== scriptIds.length ||
      new Set(value.concepts.map(c => object(c) ? c.scriptId : null)).size !== scriptIds.length) return false;
  const evaluations = value.evaluations, concepts = value.concepts;
  return value.choices.every(c => {
    if (!object(c) || !scriptIds.includes(String(c.scriptId)) || !texts(c.mustPreserve) || c.mustPreserve.length < 2 || c.mustPreserve.length > 4) return false;
    const idea = ideas.get(String(c.ideaId));
    if (!idea || !evaluations.some(e => object(e) && e.ideaId === idea.id && e.verdict === 'ADVANCE')) return false;
    const expected = dramaConcept(idea, String(c.scriptId)), actual = concepts.find(v => object(v) && v.scriptId === c.scriptId);
    return object(actual) && object(actual.plan) && Object.entries(expected).every(([k,v]) => k === 'plan'
      ? Object.entries(expected.plan).every(([field, content]) => (actual.plan as Record<string,unknown>)[field] === content)
      : actual[k] === v);
  });
}
