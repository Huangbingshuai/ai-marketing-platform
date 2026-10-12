import { describe, expect, it } from 'vitest';
import { emptyCustomizedBrief } from './customized-extraction';
import {
  CUSTOMIZED_STORYBOARD_STAGES,
  storyboardProgress,
  validateStoryboardCheckpoint,
  validateStoryboardSettings,
  validateStoryboardPublication,
  type StoryboardInput,
  type StoryboardStep,
} from './customized-storyboard-generation';
import type { CustomizedStoryboardScript } from './customized-storyboard';

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
