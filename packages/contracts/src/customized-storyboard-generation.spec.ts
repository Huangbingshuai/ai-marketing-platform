import { describe, expect, it } from 'vitest';
import creationSchema from '../schemas/customized-video-script-creation.schema.json';
import conceptSchema from '../schemas/customized-storyboard-concepts.schema.json';
import { emptyCustomizedBrief } from './customized-extraction';
import {
  CUSTOMIZED_STORYBOARD_STAGES,
  storyboardProgress,
  validateStoryboardCheckpoint,
  validateStoryboardSettings,
  validateStoryboardPublication,
  validateStoryboardScreenplay,
  validateStoryboardVideoScript,
  type StoryboardInput,
  type StoryboardStep,
} from './customized-storyboard-generation';
import { CUSTOMIZED_VIDEO_TYPES, type CustomizedStoryboardScript } from './customized-storyboard';

it('keeps video types and model creative fields aligned with the Python schemas', () => {
  expect(creationSchema.properties.videoType.enum).toEqual([...CUSTOMIZED_VIDEO_TYPES]);
  expect(creationSchema.required).toEqual([
    'videoType',
    'referenceDurationSeconds',
    'structureSections',
  ]);
  expect(creationSchema.properties.structureSections.maxItems).toBe(20);
  for (const field of ['coreIdea', 'openingHook', 'productRole', 'memoryPoint'])
    expect(conceptSchema.$defs.Concept.properties).toHaveProperty(field);
});

const input: StoryboardInput = {
  schemaVersion: 1,
  source: { artifactId: 'brief', revision: 2, fingerprint: 'hash' },
  brief: emptyCustomizedBrief(),
  settings: {
    targetDurationSeconds: 30,
    variantCount: 3,
    structureMode: 'AI',
    structure: '',
    instructions: '',
  },
  scriptIds: ['a', 'b', 'c'],
  models: { creative: 'pro', detail: 'turbo' },
  existingConcepts: [],
  brandReferences: [],
};
const script: CustomizedStoryboardScript = {
  id: 'a',
  name: '日常',
  synopsis: '日常的一杯',
  structure: '',
  productFocus: '',
  assets: [{ id: 'cup', kind: 'products', name: '杯子', description: '白色' }],
  shots: [
    {
      id: 'shot',
      title: '',
      visual: '举杯',
      shotType: '特写',
      cameraMovement: '固定',
      durationSeconds: 30,
      dialogues: [],
      audio: '',
      continuity: '',
      assetRequirements: {
        characters: { state: 'NONE', items: [] },
        products: { state: 'DEFINED', items: [{ assetId: 'cup', description: '' }] },
        scenes: { state: 'NONE', items: [] },
      },
    },
  ],
};

describe('storyboard generation boundaries', () => {
  it('follows ordered custom sections while treating reference duration as soft in V2 only', () => {
    const content = 'P01｜产品亮相\n\n橙色端口从深灰轮廓中显现。';
    const story = {
      title: '亮相',
      content,
      opening: '',
      development: '',
      ending: '',
      dialoguePlan: '',
      beats: [{ id: 'P01', content, durationSeconds: 42 }],
    };
    const next: StoryboardInput = {
      ...input,
      outputMode: 'STORY_ONLY',
      storyFormat: 'VIDEO_SCRIPT_V2',
      settings: { ...input.settings, videoType: 'BRAND_AD', structureSections: ['产品亮相'] },
    };
    expect(validateStoryboardCheckpoint('STORY', story, next, 'a')).toBe(true);
    expect(
      validateStoryboardCheckpoint('STORY', story, { ...next, storyFormat: 'SCREENPLAY_V1' }, 'a'),
    ).toBe(false);
    expect(validateStoryboardVideoScript(story, ['主题回扣'])).not.toBeNull();
    expect(validateStoryboardVideoScript(story, ['产品亮相', '主题回扣'])).not.toBeNull();
    expect(validateStoryboardVideoScript({ ...story, content: '概述' })).not.toBeNull();
    const concepts = input.scriptIds.map((scriptId) => ({
      scriptId,
      name: '亮相',
      synopsis: '完整视觉篇章',
      productFocus: '轮廓',
      structure: '亮相',
      difference: '视觉',
      coreIdea: '明暗交界',
      openingHook: '橙色',
      productRole: '视觉主体',
      memoryPoint: '轮廓',
    }));
    expect(validateStoryboardCheckpoint('CONCEPT', { concepts }, next, '')).toBe(true);
    expect(
      validateStoryboardCheckpoint(
        'CONCEPT',
        { concepts: concepts.map((c) => ({ ...c, coreIdea: '' })) },
        next,
        '',
      ),
    ).toBe(false);
    expect(
      validateStoryboardSettings({ ...next.settings, structureSections: [''] }),
    ).not.toBeNull();
  });
  it('requires complete scene text for new AI tasks while keeping historical and manual publication compatible', () => {
    const content = 'S01｜内景 · 候车区｜傍晚\n\n周越合上电脑，将充电线收进包里。';
    const story = {
      title: '候车',
      content,
      opening: '',
      development: '',
      ending: '',
      dialoguePlan: '',
      beats: [{ id: 'b1', content, durationSeconds: 30 }],
    };
    const next: StoryboardInput = {
      ...input,
      outputMode: 'STORY_ONLY',
      storyFormat: 'SCREENPLAY_V1',
    };
    expect(validateStoryboardCheckpoint('STORY', story, next, 'a')).toBe(true);
    expect(validateStoryboardScreenplay(story)).toBeNull();
    const overview = { ...story, content: '候车时使用充电器' };
    expect(validateStoryboardCheckpoint('STORY', overview, next, 'a')).toBe(false);
    expect(validateStoryboardCheckpoint('STORY', overview, input, 'a')).toBe(true);
    expect(
      validateStoryboardPublication({ ...script, story: overview, shots: [], assets: [] }, 30),
    ).toBeNull();
    const malformed = {
      ...story,
      content: '概述',
      beats: [{ ...story.beats[0]!, content: '概述' }],
    };
    expect(validateStoryboardCheckpoint('STORY', malformed, next, 'a')).toBe(false);
    expect(
      validateStoryboardCheckpoint(
        'REPAIR',
        {
          script: { ...script, story: malformed, shots: [], assets: [] },
          review: { summary: '通过', findings: [] },
          reason: '修改',
          changes: [],
        },
        next,
        'a',
      ),
    ).toBe(false);
    const long = { ...story, beats: [{ ...story.beats[0]!, durationSeconds: 60 }] };
    expect(
      validateStoryboardCheckpoint(
        'STORY',
        long,
        { ...next, settings: { ...next.settings, targetDurationSeconds: 60 } },
        'a',
      ),
    ).toBe(true);
    expect(
      validateStoryboardCheckpoint(
        'STORY',
        long,
        { ...input, settings: { ...input.settings, targetDurationSeconds: 60 } },
        'a',
      ),
    ).toBe(false);
  });
  it.each([15, 30, 180])('accepts AI duration %s', (duration) =>
    expect(
      validateStoryboardSettings({ ...input.settings, targetDurationSeconds: duration }),
    ).toBeNull(),
  );
  it.each([0, 14, 181, 30.5])(
    'rejects unsupported AI duration %s without changing it',
    (duration) => {
      const settings = { ...input.settings, targetDurationSeconds: duration };
      expect(validateStoryboardSettings(settings)).toBeTruthy();
      expect(settings.targetDurationSeconds).toBe(duration);
    },
  );
  it('requires custom structure and exact counts', () => {
    expect(validateStoryboardSettings({ ...input.settings, structureMode: 'CUSTOM' })).toBeTruthy();
    expect(validateStoryboardSettings({ ...input.settings, variantCount: 6 })).toBeTruthy();
  });
  it('checks references and duration mechanically', () => {
    expect(validateStoryboardPublication(script, 30)).toBeNull();
    expect(validateStoryboardPublication(script, 31)).toBeNull();
    expect(validateStoryboardPublication(script, 32)).toBeTruthy();
    const bad = structuredClone(script);
    bad.shots[0]!.assetRequirements!.products.items[0]!.assetId = 'unknown';
    expect(validateStoryboardPublication(bad)).toBeTruthy();
  });
  it('rejects untrusted checkpoint structure and source mismatch', () => {
    expect(
      validateStoryboardCheckpoint(
        'SNAPSHOT',
        { source: { ...input.source, revision: 1 } },
        input,
        '',
      ),
    ).toBe(false);
    expect(validateStoryboardCheckpoint('SHOTS', script, input, 'a')).toBe(true);
    expect(validateStoryboardCheckpoint('SHOTS', script, input, 'b')).toBe(false);
    expect(validateStoryboardCheckpoint('CONCEPT', { concepts: [] }, input, '')).toBe(false);
    expect(
      validateStoryboardCheckpoint(
        'REVIEW',
        { summary: 'pass', findings: [{ severity: 'UNKNOWN' }] },
        input,
        'a',
      ),
    ).toBe(false);
  });
  it('tracks per-script persisted stages and never claims completion early', () => {
    const steps: Pick<StoryboardStep, 'nodeId' | 'scriptId' | 'status'>[] =
      CUSTOMIZED_STORYBOARD_STAGES.flatMap((n) =>
        (['SNAPSHOT', 'CONCEPT'].includes(n.id) ? [''] : input.scriptIds).map((scriptId) => ({
          nodeId: n.id,
          scriptId,
          status: 'SUCCEEDED' as const,
        })),
      );
    expect(storyboardProgress([], input.scriptIds, false)).toBe(0);
    expect(storyboardProgress(steps, input.scriptIds, false)).toBe(99);
    expect(storyboardProgress(steps, input.scriptIds, true)).toBe(100);
    expect(
      storyboardProgress(
        steps.filter((s) => !s.scriptId || s.scriptId === 'a'),
        input.scriptIds,
        false,
      ),
    ).toBe(43);
  });
});
