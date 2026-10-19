import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  isProductionDocument,
  productionShots,
  type ProductionVideoDocument,
  buildVideoSourceUnits,
  validateVideoPlan,
  isProductionClipPrompt,
  videoTotalMs,
  videoClipProjection,
  videoPromptReferences,
  validateClipPromptReferences,
  validatePromptAuditEvidence,
  type VideoAudit,
  productionStages,
} from './customized-production';
const fixture = () =>
  JSON.parse(
    readFileSync(resolve(__dirname, '../fixtures/customized-video-plan-v2.json'), 'utf8'),
  ) as { scriptText: string; document: ProductionVideoDocument };
describe('V2 video production canonical contract', () => {
  it('requires current prompt excerpts rather than upstream or invented quotations', () => {
    const prompt = {
      target: { kind: 'CLIP' as const, id: 'c' },
      content: '屏显（2–14秒）：正确文字',
      assetIds: [],
    };
    const review = {
      findings: [{ id: 'F1', repairKind: 'FIELDS' }],
      promptEvidence: [{ issueId: 'F1', excerpt: '上游才有的语序' }],
    } as unknown as VideoAudit;
    expect(validatePromptAuditEvidence(review, prompt)).toContain('当前提示词');
    expect(validatePromptAuditEvidence({ ...review, promptEvidence: [] }, prompt)).toContain(
      '具体原句',
    );
    expect(
      validatePromptAuditEvidence(
        { ...review, promptEvidence: [{ issueId: 'F1', excerpt: '2–14秒' }] },
        prompt,
      ),
    ).toBeNull();
    expect(
      validatePromptAuditEvidence({ ...review, findings: [], promptEvidence: [] }, prompt),
    ).toBeNull();
    const missing = { ...review };
    delete missing.promptEvidence;
    expect(validatePromptAuditEvidence(missing, prompt)).toContain('缺少');
  });
  it('resolves only actual @mentions with longest-name matching and rejects foreign references', () => {
    const { document: d } = fixture();
    const cup = d.assets.find((a) => a.id === 'cup')!;
    expect(
      videoPromptReferences('@杯架、@杯；@杯架', [
        { id: 'a', name: '杯' },
        { id: 'b', name: '杯架' },
      ]),
    ).toEqual({ assetIds: ['b', 'a'], unknown: [] });
    const prompt = {
      target: { kind: 'CLIP' as const, id: 'clip-a' },
      content: `近景呈现@${cup.name}。`,
      assetIds: ['cup'],
    };
    expect(validateClipPromptReferences(prompt, d)).toBeNull();
    expect(validateClipPromptReferences({ ...prompt, assetIds: ['cup', 'room'] }, d)).toContain(
      '@引用',
    );
    expect(validateClipPromptReferences({ ...prompt, content: '@不存在的素材' }, d)).toContain(
      '无法对应',
    );
    expect(
      validateClipPromptReferences({ ...prompt, content: '纯文字描述', assetIds: [] }, d),
    ).toBeNull();
  });
  it('freezes six prompt stages without changing historical stage definitions', () => {
    expect(productionStages('PROMPT', undefined, 2, 2).map((s) => [s.id, s.label])).toEqual([
      ['SNAPSHOT', '本镜创作依据'],
      ['PLAN', '画面与素材安排'],
      ['GENERATE', '视频提示词创作'],
      ['REVIEW', '独立审校'],
      ['REPAIR', '定向修订与复核'],
      ['SAVE', '原位保存提示词'],
    ]);
    expect(productionStages('PROMPT', undefined, 2).find((s) => s.id === 'PLAN')?.label).not.toBe(
      '画面与素材安排',
    );
  });
  it('keeps a reference duration soft, and distinguishes three shots from two video tasks', () => {
    const { document: d } = fixture();
    expect(isProductionDocument(d)).toBe(true);
    expect(videoTotalMs(d.videoPlan)).toBe(15000);
    expect(d.videoPlan.durationPolicy.seconds).toBe(10);
    expect(productionShots(d)).toHaveLength(3);
    expect(d.videoPlan.clips).toHaveLength(2);
    expect(videoClipProjection(d.videoPlan, d.videoPlan.clips[0]!).durationSeconds).toBe(10);
    expect(Object.hasOwn(d, 'shots')).toBe(false);
  });
  it('requires fixed totals only when explicitly requested', () => {
    const { document: d } = fixture();
    d.videoPlan.durationPolicy.mode = 'FIXED';
    expect(validateVideoPlan(d.videoPlan, d.assets)).toContain('固定');
    d.videoPlan.durationPolicy.seconds = 15;
    expect(isProductionDocument(d)).toBe(true);
  });
  it.each([
    'dialogue',
    'unknownScene',
    'duplicateMembership',
    'unknownBinding',
    'missingEvent',
    'speechGap',
    'speechRepeat',
    'screenTruncated',
    'missingExplicitCue',
    'cueOutOfShot',
    'tooLongClip',
    'parallelWritableShots',
  ])('rejects %s', (kind) => {
    const { document: d } = fixture(),
      p = d.videoPlan;
    switch (kind) {
      case 'dialogue':
        Object.assign(p.shots[0]!, { dialogue: '偷偷改原句' });
        break;
      case 'unknownScene':
        p.scenes[0]!.sceneAssetId = 'absent';
        break;
      case 'duplicateMembership':
        p.clips[1]!.shotIds.push('shot-a');
        break;
      case 'unknownBinding':
        p.shots[0]!.bindings[0]!.assetId = 'absent';
        break;
      case 'missingEvent':
        p.events.push({ ...p.events[0]!, id: 'uncovered' });
        break;
      case 'speechGap':
        p.cues[0]!.parts[1]!.textStart = 5;
        break;
      case 'speechRepeat':
        p.cues[0]!.parts[1]!.textStart = 0;
        break;
      case 'screenTruncated':
        p.cues[1]!.parts[0]!.textEnd = 1;
        break;
      case 'missingExplicitCue':
        p.cues = [];
        break;
      case 'cueOutOfShot':
        p.cues[0]!.parts[0]!.endMs = 6000;
        break;
      case 'tooLongClip':
        p.shots[0]!.durationSeconds = 20;
        break;
      case 'parallelWritableShots':
        Object.assign(d, { shots: [] });
        break;
    }
    expect(isProductionDocument(d)).toBe(false);
  });
  it('does not repeat a full speech line on every shot', () => {
    const { document: d } = fixture();
    const shots = productionShots(d);
    const joined = shots
      .slice(0, 2)
      .map((s) => s.dialogue.split('：')[1])
      .join('');
    expect(joined).toBe(d.videoPlan.sourceUnits[1]!.text);
  });
  it('compiles exact immutable Unicode offsets without inferring unlabeled paragraphs', () => {
    const { scriptText, document: d } = fixture();
    expect(buildVideoSourceUnits(scriptText)).toEqual(d.videoPlan.sourceUnits);
    for (const unit of buildVideoSourceUnits('😀 文字\n\n旁白：“你好。”'))
      expect(Array.from('😀 文字\n\n旁白：“你好。”').slice(unit.start, unit.end).join('')).toBe(
        unit.text,
      );
    expect(buildVideoSourceUnits('他说这只杯很好。')[0]!.kind).toBe('TEXT');
  });
  it('clip prompts use the deduplicated actual references, not all catalog assets', () => {
    const { document: d } = fixture();
    const prompt = {
      target: { kind: 'CLIP', id: 'clip-a' },
      content: '按两镜顺序呈现杯与桌面',
      assetIds: ['cup', 'room'],
    };
    expect(isProductionClipPrompt(prompt, d.videoPlan)).toBe(true);
    expect(isProductionClipPrompt({ ...prompt, assetIds: ['cup'] }, d.videoPlan)).toBe(true);
    expect(
      isProductionClipPrompt({ ...prompt, assetIds: ['cup', 'room', 'unrelated'] }, d.videoPlan),
    ).toBe(false);
  });
});
