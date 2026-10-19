import { videoExecutionDetail } from './video-execution-detail';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  type ProductionVideoDocument,
  type ProductionInput,
  type VideoAudit,
} from '@ai-marketing/contracts';
import {
  clipPayload,
  mergeVideoSection,
  validateVideoSnapshot,
  validateVideoAudit,
  validateFinalVideo,
  validateFinalClipPrompt,
  videoHash,
} from './video-production.domain';
const fixture = () =>
  JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
      ),
      'utf8',
    ),
  ) as { scriptText: string; document: ProductionVideoDocument };
const audit = (): VideoAudit => ({
  summary: '核对实际分镜',
  checks: [
    '原稿兑现',
    '时间容量',
    '镜头表达',
    '产品事实',
    '动作与空间',
    '素材绑定',
    '模型能力',
  ].map((dimension) => ({ dimension, conclusion: '实际内容已核对' })),
  findings: [],
  resolutions: [],
});
const input = (d: ProductionVideoDocument, text: string) =>
  ({
    document: d,
    sourceUnits: d.videoPlan.sourceUnits,
    sources: d.videoPlan.sources,
    durationPolicy: d.videoPlan.durationPolicy,
    renderCapability: d.videoPlan.capability,
    script: { story: { content: text } },
  }) as unknown as ProductionInput;
describe('video task source and review fences', () => {
  it('requires current-prompt quotation evidence for V3 callbacks and keeps V2 compatible', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText);
    i.operation = 'PROMPT';
    i.shotWorkflowVersion = 2;
    i.promptWorkflowVersion = 3;
    i.target = { kind: 'CLIP', id: 'clip-b' };
    const prompt = { target: i.target, content: '@陶瓷杯定版', assetIds: ['cup'] };
    const saved = { audit: audit(), auditHash: videoHash(prompt) };
    expect(validateFinalClipPrompt(prompt, i, saved)).toContain('缺少');
    expect(
      validateFinalClipPrompt(prompt, i, { ...saved, audit: { ...audit(), promptEvidence: [] } }),
    ).toBeNull();
    i.promptWorkflowVersion = 2;
    expect(validateFinalClipPrompt(prompt, i, saved)).toBeNull();
  });
  it('requires exact snapshots including Brief and immutable text', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText);
    expect(validateVideoSnapshot(d, i)).toBeNull();
    const changed = structuredClone(d);
    changed.videoPlan.sourceUnits[1]!.text = '被删改';
    expect(validateVideoSnapshot(changed, i)).not.toBeNull();
  });
  it('keeps V2 plan through asset edits, and assets through shot edits', () => {
    const { document: d } = fixture();
    const incoming = structuredClone(d);
    incoming.assets[0]!.description = '人工修改';
    expect(mergeVideoSection(d, incoming, 'ASSETS')).toEqual({ ...d, assets: incoming.assets });
    expect(mergeVideoSection(d, incoming, 'SHOTS')).toEqual(d);
  });
  it('does not invalidate an unrelated clip fingerprint through global numbering', () => {
    const { document: d } = fixture();
    const old = videoHash(clipPayload(d, 'clip-b'));
    d.videoPlan.shots[0]!.visual = '前一片段发生修改';
    expect(videoHash(clipPayload(d, 'clip-b'))).toBe(old);
    d.videoPlan.shots[2]!.visual = '定版画面修改';
    expect(videoHash(clipPayload(d, 'clip-b'))).not.toBe(old);
  });
  it('rejects nonexistent evidence instead of treating it as a content error or success', () => {
    const { document: d } = fixture(),
      a = audit();
    a.findings = [
      {
        id: 'f',
        severity: 'ERROR',
        category: 'STATE',
        title: '定版未说明',
        impact: '物体出现',
        evidence: [{ entity: 'SHOT', id: 'missing', field: 'visual' }],
        affectedShotIds: ['shot-c'],
        affectedClipIds: ['clip-b'],
        suggestedFix: '核对',
        repairKind: 'FIELDS',
      },
    ];
    expect(validateVideoAudit(a, d.videoPlan)).not.toBeNull();
    a.findings[0]!.evidence = [{ entity: 'SHOT', id: 'shot-c', field: 'visual' }];
    expect(validateVideoAudit(a, d.videoPlan)).toBeNull();
  });
  it('requires every original error to resolve with real current evidence', () => {
    const { document: d } = fixture(),
      a = audit();
    a.findings = [
      {
        id: 'f',
        severity: 'ERROR',
        category: 'CAPACITY',
        title: '容量',
        impact: '过密',
        evidence: [{ entity: 'SHOT', id: 'shot-a', field: 'visual' }],
        affectedShotIds: ['shot-a'],
        affectedClipIds: ['clip-a'],
        suggestedFix: '拆镜',
        repairKind: 'STRUCTURE',
      },
    ];
    const r = audit();
    expect(validateVideoAudit(r, d.videoPlan, a)).not.toBeNull();
    r.resolutions = [
      {
        issueId: 'f',
        status: 'RESOLVED',
        evidence: [{ entity: 'SHOT', id: 'shot-a', field: 'visual' }],
        explanation: '真实内容已核对',
      },
    ];
    expect(validateVideoAudit(r, d.videoPlan, a)).toBeNull();
  });
  it('does not accept review for an older candidate', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText),
      saved = { audit: audit(), auditHash: videoHash(d.videoPlan) };
    expect(validateFinalVideo(d, i, saved)).toBeNull();
    const changed = structuredClone(d);
    changed.videoPlan.shots[0]!.visual = '修改过的实际画面';
    expect(validateFinalVideo(changed, i, saved)).toContain('当前采用稿');
  });
  it('requires one complete storyboard per task for the new generation strategy, while retaining legacy reads', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText);
    i.strategyVersion = '2026-10-19-capacity-clips.7';
    i.operation = 'SHOTS';
    expect(
      validateFinalVideo(d, i, { audit: audit(), auditHash: videoHash(d.videoPlan) }),
    ).toContain('一条完整分镜');
    i.strategyVersion = '2026-10-19-capacity-clips.6';
    expect(
      validateFinalVideo(d, i, { audit: audit(), auditHash: videoHash(d.videoPlan) }),
    ).toBeNull();
  });
  it('shows the real clip prompt without unrelated clip content', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText);
    i.shotWorkflowVersion = 2;
    i.operation = 'PROMPT';
    i.target = { kind: 'CLIP', id: 'clip-b' };
    const prompt = {
      target: i.target,
      content: '片段二实际生成的完整提示词',
      assetIds: ['cup', 'room'],
    };
    const detail = videoExecutionDetail(
      { id: 'GENERATE', status: 'SUCCEEDED', title: '片段创作', content: '已保存' },
      i,
      { value: prompt },
    );
    expect(JSON.stringify(detail)).toContain(prompt.content);
    expect(JSON.stringify(detail)).not.toContain(d.videoPlan.shots[0]!.visual);
  });
  it('shows actual current prompt arrangement and voice windows, not another clip', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText);
    i.shotWorkflowVersion = 2;
    i.promptWorkflowVersion = 2;
    i.operation = 'PROMPT';
    i.target = { kind: 'CLIP', id: 'clip-b' };
    const detail = videoExecutionDetail(
      { id: 'PLAN', status: 'SUCCEEDED', title: '画面与素材安排', content: '已整理' },
      i,
      { plan: { summary: '已整理' } },
    )!;
    expect(JSON.stringify(detail)).toContain('实际时长');
    expect(JSON.stringify(detail)).toContain(d.videoPlan.shots[2]!.visual);
    expect(JSON.stringify(detail)).not.toContain(d.videoPlan.shots[0]!.visual);
    expect(JSON.stringify(detail)).toContain('一杯清晨');
  });
  it('resolves first-review evidence from the original candidate instead of a later repair', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText);
    i.shotWorkflowVersion = 2;
    const revised = structuredClone(d);
    revised.videoPlan.shots[0]!.visual = '修订后单独拍摄的画面';
    const a = audit();
    a.findings = [
      {
        id: 'f',
        title: '画面待核对',
        impact: '原稿动作',
        suggestedFix: '核对动作',
        severity: 'WARNING',
        category: 'STATE',
        repairKind: 'FIELDS',
        affectedShotIds: ['shot-a'],
        affectedClipIds: ['clip-a'],
        evidence: [{ entity: 'SHOT', id: 'shot-a', field: 'visual' }],
      },
    ];
    const detail = videoExecutionDetail(
      { id: 'REVIEW', status: 'SUCCEEDED', title: '初审', content: '初审记录' },
      i,
      { value: d, revised, audit: a },
    );
    expect(JSON.stringify(detail)).toContain(d.videoPlan.shots[0]!.visual);
    expect(JSON.stringify(detail)).not.toContain(revised.videoPlan.shots[0]!.visual);
  });
  it('requires stable issue identity and a complete severity change record', () => {
    const { document: d } = fixture(),
      previous = audit();
    previous.findings = [
      {
        id: 'same-issue',
        severity: 'WARNING',
        category: 'STATE',
        title: '动作衔接',
        impact: '状态未写清',
        evidence: [{ entity: 'SHOT', id: 'shot-a', field: 'visual' }],
        affectedShotIds: ['shot-a'],
        affectedClipIds: ['clip-a'],
        suggestedFix: '核对连续动作',
        repairKind: 'FIELDS',
      },
    ];
    const changed = {
      ...audit(),
      findings: [{ ...previous.findings[0]!, severity: 'ERROR' as const }],
      severityChanges: [],
    };
    expect(validateVideoAudit(changed, d.videoPlan, previous)).toContain('定级变化');
    const justified = {
      ...changed,
      severityChanges: [
        {
          issueId: 'same-issue',
          fromSeverity: 'WARNING' as const,
          toSeverity: 'ERROR' as const,
          reason: 'INITIAL_REVIEW_CORRECTION' as const,
          explanation: '首审将明确的物理矛盾错误归为建议，当前证据仍是该矛盾。',
          evidence: previous.findings[0]!.evidence,
        },
      ],
    };
    expect(validateVideoAudit(justified, d.videoPlan, previous)).toBeNull();
    const detail = videoExecutionDetail(
      { id: 'REPAIR', status: 'SUCCEEDED', title: '复核', content: '实际复核' },
      { ...input(d, fixture().scriptText), shotWorkflowVersion: 2 },
      { value: d, recheck: justified },
    );
    expect(JSON.stringify(detail)).toContain('更正首次审校定级');
    expect(JSON.stringify(detail)).toContain(justified.severityChanges[0]!.explanation);
  });
  it('does not treat unchanged evidence as new evidence in a new-strategy completion', () => {
    const { document: d, scriptText } = fixture(),
      i = input(d, scriptText);
    i.strategyVersion = '2026-10-19-capacity-clips.4';
    const old = audit();
    old.findings = [
      {
        id: 'w',
        severity: 'ERROR',
        category: 'STATE',
        title: '动作衔接',
        impact: '状态冲突',
        evidence: [{ entity: 'SHOT', id: 'shot-a', field: 'visual' }],
        affectedShotIds: ['shot-a'],
        affectedClipIds: ['clip-a'],
        suggestedFix: '核对',
        repairKind: 'FIELDS',
      },
    ];
    const next: VideoAudit = {
      ...audit(),
      findings: [{ ...old.findings[0]!, severity: 'WARNING' as const }],
      resolutions: [
        {
          issueId: 'w',
          status: 'RESOLVED' as const,
          evidence: old.findings[0]!.evidence,
          explanation: '重新分类',
        },
      ],
      severityChanges: [
        {
          issueId: 'w',
          fromSeverity: 'ERROR' as const,
          toSeverity: 'WARNING' as const,
          reason: 'NEW_EVIDENCE' as const,
          explanation: '声称原文已变',
          evidence: old.findings[0]!.evidence,
        },
      ],
    };
    expect(
      validateFinalVideo(d, i, {
        value: d,
        audit: old,
        recheck: next,
        recheckHash: videoHash(d.videoPlan),
      }),
    ).toContain('未变化的证据');
    next.severityChanges![0]!.reason = 'INITIAL_REVIEW_CORRECTION';
    expect(
      validateFinalVideo(d, i, {
        value: d,
        audit: old,
        recheck: next,
        recheckHash: videoHash(d.videoPlan),
      }),
    ).toBeNull();
  });
});
