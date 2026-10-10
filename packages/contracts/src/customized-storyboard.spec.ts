import { describe, expect, it } from 'vitest';
import {
  isCustomizedStoryboardDraft,
  isCustomizedStoryboardScript,
  type CustomizedStoryboardDraft,
  type CustomizedStoryboardScript,
} from './customized-storyboard';
const fixture = (): CustomizedStoryboardDraft => ({
  schemaVersion: 1,
  source: null,
  settings: {
    targetDurationSeconds: 30,
    variantCount: 3,
    structureMode: 'AI',
    structure: '',
    instructions: '',
  },
  scripts: [],
  activeScriptId: null,
  mainCandidateId: null,
});

const assetScript = (): CustomizedStoryboardScript => ({
  id: 'script',
  name: '脚本',
  synopsis: '',
  structure: '',
  productFocus: '',
  assets: [{ id: 'product', kind: 'products', name: '青梅酱', description: '透明玻璃瓶' }],
  shots: [
    {
      id: 'shot',
      title: '',
      shotType: '',
      cameraMovement: '',
      durationSeconds: 5,
      visual: '',
      audio: '',
      continuity: '',
      dialogues: [],
      assetRequirements: {
        characters: { state: 'NONE', items: [] },
        products: { state: 'DEFINED', items: [{ assetId: 'product', description: '瓶盖打开' }] },
        scenes: { state: 'UNDEFINED', items: [] },
      },
    },
  ],
});
describe('storyboard asset requirements', () => {
  it('accepts stable shared identities across shots without requiring files or media', () => {
    const script = assetScript();
    script.shots.push({ ...structuredClone(script.shots[0]!), id: 'shot-2' });
    expect(isCustomizedStoryboardScript(script)).toBe(true);
    expect(isCustomizedStoryboardDraft({ ...fixture(), scripts: [script] })).toBe(true);
  });
  it('keeps legacy v1 scripts valid and does not infer missing asset requirements', () => {
    const script = assetScript();
    delete script.assets;
    delete script.shots[0]!.assetRequirements;
    expect(isCustomizedStoryboardScript(script)).toBe(true);
    expect(script.assets).toBeUndefined();
    expect(script.shots[0]!.assetRequirements).toBeUndefined();
  });
  it.each([
    'missing',
    'duplicate',
    'wrong-kind',
    'none-with-items',
    'defined-without-items',
    'unknown-state',
    'coerced-state',
    'partial',
    'null',
  ])('rejects invalid references or category state: %s', (caseName) => {
    const script = assetScript();
    const groups = script.shots[0]!.assetRequirements!;
    if (caseName === 'missing') groups.products.items[0]!.assetId = 'missing';
    if (caseName === 'duplicate') groups.products.items.push({ ...groups.products.items[0]! });
    if (caseName === 'wrong-kind') script.assets![0]!.kind = 'characters';
    if (caseName === 'none-with-items') groups.products.state = 'NONE';
    if (caseName === 'defined-without-items') groups.products.items = [];
    if (caseName === 'unknown-state') Object.assign(groups.products, { state: 'GENERATED' });
    if (caseName === 'coerced-state') Object.assign(groups.products, { state: ['DEFINED'] });
    if (caseName === 'partial') Reflect.deleteProperty(groups, 'scenes');
    if (caseName === 'null') Object.assign(script.shots[0]!, { assetRequirements: null });
    expect(isCustomizedStoryboardScript(script)).toBe(false);
  });
  it.each([
    'blank',
    'too-long',
    'duplicate',
    'unknown-kind',
    'invalid-description',
    'missing-fields',
  ])('rejects invalid object definitions: %s', (caseName) => {
    const script = assetScript();
    const asset = script.assets![0]!;
    if (caseName === 'blank') asset.name = ' ';
    if (caseName === 'too-long') asset.name = 'a'.repeat(201);
    if (caseName === 'duplicate') script.assets!.push({ ...asset });
    if (caseName === 'unknown-kind') Object.assign(asset, { kind: 'props' });
    if (caseName === 'invalid-description') asset.description = 'a'.repeat(20001);
    if (caseName === 'missing-fields') Reflect.deleteProperty(asset, 'description');
    expect(isCustomizedStoryboardScript(script)).toBe(false);
  });
});
describe('customized storyboard draft contract', () => {
  it('accepts empty drafts without inventing an output or main script', () =>
    expect(isCustomizedStoryboardDraft(fixture())).toBe(true));
  it.each([
    {},
    null,
    { ...fixture(), schemaVersion: 2 },
    { ...fixture(), source: { artifactId: 'a', revision: 0 } },
    { ...fixture(), activeScriptId: 'missing' },
    { ...fixture(), mainCandidateId: 'missing' },
  ])('rejects incompatible or dangling state %#', (value) =>
    expect(isCustomizedStoryboardDraft(value)).toBe(false),
  );
  it.each([0, NaN, Infinity, 3601])('rejects invalid duration %s', (value) => {
    const state = fixture();
    state.settings.targetDurationSeconds = value;
    expect(isCustomizedStoryboardDraft(state)).toBe(false);
  });
  it.each(['WRONG', null])('rejects unknown structure mode %s', (value) =>
    expect(
      isCustomizedStoryboardDraft({
        ...fixture(),
        settings: { ...fixture().settings, structureMode: value },
      }),
    ).toBe(false),
  );
  it('validates imported scripts, shot IDs and dialogue IDs', () => {
    const shot = {
      id: 'shot',
      title: '镜头',
      shotType: '近景',
      cameraMovement: '固定镜头',
      durationSeconds: 5,
      visual: '画面',
      audio: '',
      continuity: '',
      dialogues: [{ id: 'd', speaker: '旁白', text: '文字' }],
    };
    const script = {
      id: 'script',
      name: '脚本',
      synopsis: '',
      structure: '',
      productFocus: '',
      shots: [shot],
    };
    expect(isCustomizedStoryboardScript(script)).toBe(true);
    expect(isCustomizedStoryboardScript({ ...script, shots: [shot, shot] })).toBe(false);
    expect(
      isCustomizedStoryboardScript({
        ...script,
        shots: [{ ...shot, dialogues: [...shot.dialogues, ...shot.dialogues] }],
      }),
    ).toBe(false);
    expect(isCustomizedStoryboardDraft({ ...fixture(), scripts: [script, script] })).toBe(false);
    expect(
      isCustomizedStoryboardDraft({
        ...fixture(),
        scripts: [script],
        activeScriptId: 'script',
        mainCandidateId: 'script',
      }),
    ).toBe(true);
  });
});
