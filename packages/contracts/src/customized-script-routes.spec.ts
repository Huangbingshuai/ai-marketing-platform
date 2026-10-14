import { describe, it, expect } from 'vitest';
import { CUSTOMIZED_VIDEO_TYPES } from './customized-storyboard';
import { emptyCustomizedBrief } from './customized-extraction';
import {
  storyboardStages,
  storyboardProgress,
  validateStoryboardCheckpoint,
  validateStoryboardVideoScript,
  type StoryboardInput,
} from './customized-storyboard-generation';
import {
  SCRIPT_PLAN_FIELDS,
  SCRIPT_QUALITY_CRITERIA,
  typedScriptStages,
  validateScriptStructureMapping,
} from './customized-script-routes';
import schema from '../schemas/customized-typed-script-concepts.schema.json';

const input: StoryboardInput = {
  schemaVersion: 1,
  outputMode: 'STORY_ONLY',
  storyFormat: 'VIDEO_SCRIPT_V3',
  graphVersion: 'TYPED_CREATION_V1',
  routeId: 'BRAND_AD',
  source: { artifactId: 'brief', revision: 1, fingerprint: 'fixed' },
  brief: emptyCustomizedBrief(),
  settings: {
    videoType: 'BRAND_AD',
    targetDurationSeconds: 30,
    variantCount: 1,
    structureMode: 'CUSTOM',
    structure: '吸引、兑现',
    structureSections: ['吸引注意', '价值兑现'],
    instructions: '',
  },
  models: { creative: 'controlled', detail: 'controlled' },
  scriptIds: ['s'],
  existingConcepts: [],
  brandReferences: [],
};
const story = {
  title: '晨光',
  content: 'P01｜桌边晨光\n\n橙色端口从阴影中显露。',
  opening: '',
  development: '',
  ending: '',
  dialoguePlan: '',
  beats: [{ id: 'P01', content: 'P01｜桌边晨光\n\n橙色端口从阴影中显露。', durationSeconds: 32 }],
  structureMapping: ['R01', 'R02'].map((requirementId) => ({
    requirementId,
    beatIds: ['P01'],
    evidence: '橙色端口从阴影中显露',
  })),
};
describe('typed script contract', () => {
  it('requires route-specific quality checks only for the new frozen strategy', () => {
    const modern = {
      ...input,
      strategyVersions: {
        concept: '2026-10-13.4',
        story: '2026-10-13.4',
        review: '2026-10-13.4',
        repair: '2026-10-13.4',
      },
    };
    const legacyReview = { summary: '已核对', findings: [] };
    expect(validateStoryboardCheckpoint('BRAND_AD_REVIEW', legacyReview, input, 's')).toBe(true);
    expect(validateStoryboardCheckpoint('BRAND_AD_REVIEW', legacyReview, modern, 's')).toBe(false);
    const checked = {
      ...legacyReview,
      routeId: 'BRAND_AD',
      qualityChecks: SCRIPT_QUALITY_CRITERIA.BRAND_AD.map((criterion) => ({
        criterion,
        verdict: 'PASS',
        beatIds: ['P01'],
        evidence: '橙色端口从阴影中显露',
        reason: '正文依据',
        suggestion: '',
      })),
    };
    expect(validateStoryboardCheckpoint('BRAND_AD_REVIEW', checked, modern, 's')).toBe(true);
    expect(
      validateStoryboardCheckpoint(
        'BRAND_AD_REVIEW',
        { ...checked, routeId: 'DRAMA' },
        modern,
        's',
      ),
    ).toBe(false);
    expect(
      validateStoryboardCheckpoint(
        'BRAND_AD_REVIEW',
        { ...checked, qualityChecks: checked.qualityChecks.slice(1) },
        modern,
        's',
      ),
    ).toBe(false);
  });
  it.each(CUSTOMIZED_VIDEO_TYPES)('only selected route %s contributes to progress', (routeId) => {
    const stages = storyboardStages({ ...input, routeId });
    expect(stages.map((s) => s.id)).toContain(`${routeId}_STORY`);
    expect(stages.reduce((n, s) => n + s.weight, 0)).toBe(100);
    expect(
      storyboardProgress(
        [
          { nodeId: 'SNAPSHOT', scriptId: '', status: 'SUCCEEDED' },
          { nodeId: 'PREPARE', scriptId: '', status: 'SUCCEEDED' },
        ],
        ['s'],
        false,
        true,
        { ...input, routeId },
      ),
    ).toBe(10);
    expect(storyboardProgress([], ['s'], false, true, { ...input, routeId })).toBe(0);
  });
  it('accepts semantic mapping without forcing body headings and preserves V2 strict rules', () => {
    expect(validateScriptStructureMapping(story, input.settings.structureSections!)).toBeNull();
    expect(validateStoryboardCheckpoint('BRAND_AD_STORY', story, input, 's')).toBe(true);
    expect(validateStoryboardCheckpoint('DRAMA_STORY', story, input, 's')).toBe(false);
    expect(validateStoryboardVideoScript(story, input.settings.structureSections)).not.toBeNull();
    expect(
      validateScriptStructureMapping(
        { ...story, structureMapping: [] },
        input.settings.structureSections!,
      ),
    ).not.toBeNull();
    expect(
      validateScriptStructureMapping(
        {
          ...story,
          structureMapping: story.structureMapping.map((m) => ({ ...m, evidence: '伪造引文' })),
        },
        input.settings.structureSections!,
      ),
    ).not.toBeNull();
  });
  it('persists a missing-info result without requiring invented concepts', () => {
    expect(
      validateStoryboardCheckpoint(
        'BRAND_AD_CONCEPT',
        {
          readiness: { status: 'NEEDS_INFORMATION', reason: '资料缺失', missing: ['产品依据'] },
          concepts: [],
        },
        input,
        '',
      ),
    ).toBe(true);
    expect(
      validateStoryboardCheckpoint(
        'BRAND_AD_CONCEPT',
        { readiness: { status: 'READY', reason: '足够', missing: [] }, concepts: [] },
        input,
        '',
      ),
    ).toBe(false);
  });
  it('shares route-specific plan fields with Python schema', () => {
    const definitions = schema.$defs as Record<string, { properties: Record<string, unknown> }>;
    const names = ['EcommercePlan', 'LocalStorePlan', 'BrandPlan', 'DramaPlan'];
    CUSTOMIZED_VIDEO_TYPES.forEach((type, i) =>
      expect(Object.keys(definitions[names[i]!]!.properties).sort()).toEqual(
        ['videoType', ...Object.keys(SCRIPT_PLAN_FIELDS[type])].sort(),
      ),
    );
    expect(typedScriptStages('DRAMA').some((s) => s.id === 'RECHECK')).toBe(true);
  });
});
