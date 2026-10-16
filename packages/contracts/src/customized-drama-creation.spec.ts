import { expect, it } from 'vitest';
import fixture from '../fixtures/customized-drama-creation.json';
import { DRAMA_CREATION_VERSION, DRAMA_CREATION_VERSIONS, isDramaStrategy, dramaConcept, validateDramaDevelopment, validateDramaSelection, type DramaDevelopment } from './customized-drama-creation';
import { storyboardStages, validateStoryboardCheckpoint, type StoryboardInput } from './customized-storyboard-generation';
import { scriptStrategyVersion } from './customized-script-routes';
const input=fixture.input as unknown as StoryboardInput;
const selection=fixture.selection;
const development=selection.development as DramaDevelopment;
it('keeps historical drama tasks valid while new tasks freeze the current strategy',()=>{
  expect(DRAMA_CREATION_VERSION).toBe('2026-10-16-drama.11');
  expect(scriptStrategyVersion('DRAMA')).toBe(DRAMA_CREATION_VERSION);
  expect(DRAMA_CREATION_VERSIONS).toEqual(['2026-10-14-drama.1','2026-10-14-drama.2','2026-10-14-drama.3','2026-10-16-drama.4','2026-10-16-drama.5','2026-10-16-drama.6','2026-10-16-drama.7','2026-10-16-drama.8','2026-10-16-drama.9','2026-10-16-drama.10',DRAMA_CREATION_VERSION]);
  for(const version of DRAMA_CREATION_VERSIONS) {
    expect(isDramaStrategy(version)).toBe(true);
    const frozen={...input,strategyVersions:{concept:version,story:version,review:version,repair:version}};
    expect(validateStoryboardCheckpoint('DRAMA_CONCEPT',selection,frozen,'')).toBe(true);
  }
  expect(isDramaStrategy('2026-10-16-drama.unknown')).toBe(false);
});
it('shares original drama selection and projection with Python without a subtype selector',()=>{
  expect(scriptStrategyVersion('DRAMA')).toBe(DRAMA_CREATION_VERSION);
  expect(validateDramaDevelopment(development,input.brief,1)).toBe(true);
  expect(validateDramaSelection(selection,development,input.scriptIds)).toBe(true);
  expect(selection.concepts[0]).toEqual(dramaConcept(development.ideas[0] as never,'s0'));
  expect(validateStoryboardCheckpoint('DRAMA_CONCEPT',selection,input,'')).toBe(true);
  expect(storyboardStages(input).find(s=>s.id==='DRAMA_CONCEPT')!.label).toBe('剧情开发与独立择优');
  expect(validateStoryboardCheckpoint('DRAMA_REVIEW',{summary:'通过',findings:[]},input,'s0')).toBe(false);
});
it.each(['foreignFact','duplicate','emptyPlan','count'])('rejects invalid drama development %s',which=>{
  const d=structuredClone(development);
  if(which==='foreignFact') d.ideas[0]!.factIds=['foreign'];
  if(which==='duplicate') d.ideas[1]!.id=d.ideas[0]!.id;
  if(which==='emptyPlan') d.ideas[0]!.plan.choice=' ';
  if(which==='count') d.ideas.pop();
  expect(validateDramaDevelopment(d,input.brief,1)).toBe(false);
});
it.each(['identity','rejected','coverage','projection','missingReadiness'])('rejects forged drama selection %s',which=>{
  const s=structuredClone(selection);
  if(which==='identity') s.choices[0]!.scriptId='foreign';
  if(which==='rejected') s.evaluations[0]!.verdict='REJECT';
  if(which==='coverage') s.evaluations.pop();
  if(which==='projection') s.concepts[0]!.plan.choice='模型暗改原案';
  if(which==='missingReadiness') s.readiness.status='NEEDS_INFORMATION';
  expect(validateDramaSelection(s,development,input.scriptIds)).toBe(false);
});
