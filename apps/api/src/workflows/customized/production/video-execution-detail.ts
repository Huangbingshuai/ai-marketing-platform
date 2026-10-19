import {
  videoClipAssetIds,
  videoClipMs,
  videoClipShots,
  videoReadableText,
  videoCueText,
  type ProductionInput,
  type ProductionStep,
  type ProductionExecutionDetail,
  type VideoAudit,
  isVideoDocument,
  isProductionDocument,
  type ProductionClipPrompt,
  type VideoEvidence,
} from '@ai-marketing/contracts';
import { candidateDocument, videoEvidenceValue } from './video-production.domain';
type Section = ProductionExecutionDetail['sections'][number];
export function videoExecutionDetail(
  step: ProductionStep,
  input: ProductionInput,
  output: unknown,
): ProductionExecutionDetail | undefined {
  if (input.shotWorkflowVersion !== 2) return;
  const saved = (output ?? {}) as Record<string, unknown>;
  // A review must display the exact candidate it inspected, not a later repair.
  const candidate =
    ['GENERATE', 'REVIEW'].includes(step.id) &&
    isProductionDocument(saved.value) &&
    isVideoDocument(saved.value)
      ? saved.value
      : candidateDocument(saved);
  const p =
    candidate?.videoPlan ??
    (isVideoDocument(input.document) ? input.document.videoPlan : undefined);
  const prompt =
    input.operation === 'PROMPT'
      ? ((saved.final ?? saved.revised ?? saved.value) as ProductionClipPrompt | undefined)
      : undefined;
  const evidenceText = (e: VideoEvidence): string | null => {
    if (!p) return null;
    if (e.field === 'id') {
      return (
        p.shots.find((x) => x.id === e.id)?.title ??
        p.clips.find((x) => x.id === e.id)?.title ??
        p.scenes.find((x) => x.id === e.id)?.name ??
        p.events.find((x) => x.id === e.id)?.description ??
        p.sourceUnits.find((x) => x.id === e.id)?.text ??
        (p.cues.find((x) => x.id === e.id) ? '原稿声音或画面文字' : null)
      );
    }
    if (e.field === 'bindings') {
      const shot = p.shots.find((s) => s.id === e.id);
      return (
        shot?.bindings
          .map(
            (b) =>
              `${input.document.assets.find((a) => a.id === b.assetId)?.name ?? '对象'}：${b.description}`,
          )
          .join('\n') ?? null
      );
    }
    if (e.field === 'shotIds')
      return (
        p.clips
          .find((c) => c.id === e.id)
          ?.shotIds.map((id) => p.shots.find((s) => s.id === id)?.title ?? '镜头')
          .join('、') ?? null
      );
    if (e.field === 'sourceEventIds')
      return (
        p.shots
          .find((s) => s.id === e.id)
          ?.sourceEventIds.map((id) => p.events.find((v) => v.id === id)?.description ?? '原稿事件')
          .join('；') ?? null
      );
    if (e.field === 'sceneAssetId')
      return (
        input.document.assets.find(
          (a) => a.id === p.scenes.find((s) => s.id === e.id)?.sceneAssetId,
        )?.name ?? null
      );
    if (e.field === 'sceneId')
      return (
        p.scenes.find((s) => s.id === p.clips.find((c) => c.id === e.id)?.sceneId)?.name ?? null
      );
    if (e.field === 'assetIds')
      return (
        prompt?.assetIds
          .map((id) => input.document.assets.find((a) => a.id === id)?.name ?? '对象')
          .join('、') ?? null
      );
    if (e.field === 'parts') {
      const cue = p.cues.find((c) => c.id === e.id);
      return (
        cue?.parts
          .map(
            (part) =>
              `${p.shots.find((s) => s.id === part.shotId)?.title ?? '镜头'} ${part.startMs / 1000}–${part.endMs / 1000}秒`,
          )
          .join('\n') ?? null
      );
    }
    if (e.field === 'sourceRefs') {
      const event = p.events.find((v) => v.id === e.id);
      return (
        event?.sourceRefs
          .map((r) =>
            Array.from(p.sourceUnits.find((u) => u.id === r.unitId)?.text ?? '')
              .slice(r.start, r.end)
              .join(''),
          )
          .join('\n') ?? null
      );
    }
    return videoEvidenceValue(p, e, prompt);
  };
  const sections: Section[] = [];
  const prose = (value: string) => (p ? videoReadableText(p, input.document.assets, value) : value);
  const add = (title: string, fields: [string, string | undefined][]) =>
    sections.push({
      title,
      fields: fields
        .filter((p): p is [string, string] => !!p[1])
        .map(([label, value]) => ({ label, value })),
    });
  const currentClips =
    p?.clips.filter((clip) => input.operation !== 'PROMPT' || clip.id === input.target?.id) ?? [];
  if (step.id === 'SNAPSHOT' && input.operation === 'PROMPT' && p) {
    for (const clip of currentClips) {
      add(clip.title, [
        ['实际时长', `${videoClipMs(p, clip) / 1000} 秒`],
        [
          '本段镜头',
          videoClipShots(p, clip)
            .map((s) => `${s.title}：${s.visual}`)
            .join('\n'),
        ],
        ['开始状态', clip.startState],
        ['结束状态', clip.endState],
      ]);
      for (const assetId of videoClipAssetIds(p, clip)) {
        const asset = input.document.assets.find((a) => a.id === assetId);
        if (asset)
          add(asset.name, [
            ['公共形象', asset.description],
            ['明确事实', asset.knownFacts],
          ]);
      }
    }
  } else if (step.id === 'SNAPSHOT') {
    add(input.script.name, [
      ['已确认正文', input.script.story?.content ?? input.script.synopsis],
      [
        '时长口径',
        `${input.durationPolicy?.mode === 'FIXED' ? '固定' : '参考'} ${input.durationPolicy?.seconds} 秒`,
      ],
      [
        '制作能力',
        input.renderCapability?.status === 'PENDING_MODEL_CHECK'
          ? '文字规划配置，实际渲染前核对模型能力'
          : '已配置的制作能力',
      ],
    ]);
    for (const a of input.document.assets)
      add(a.name, [
        ['公共形象', a.description],
        ['明确事实', a.knownFacts],
        ['设计与待确认', a.designNotes],
      ]);
  } else if (step.id === 'PLAN' && input.operation === 'PROMPT' && p) {
    for (const clip of currentClips) {
      add(clip.title, [
        ['实际时长', `${videoClipMs(p, clip) / 1000} 秒`],
        ['呈现依据', '沿用已确认分镜，不重新编写故事或拆分任务'],
        [
          '画面安排',
          videoClipShots(p, clip)
            .map((s) => s.visual)
            .join('\n'),
        ],
        [
          '氛围与光线',
          videoClipShots(p, clip)
            .map((s) => s.atmosphere)
            .join('；'),
        ],
      ]);
      for (const id of videoClipAssetIds(p, clip)) {
        const a = input.document.assets.find((a) => a.id === id);
        if (a)
          add(a.name, [
            [
              '素材用途',
              videoClipShots(p, clip)
                .flatMap((s) =>
                  s.bindings.filter((b) => b.assetId === id).map((b) => b.description),
                )
                .filter(Boolean)
                .join('；') || a.description,
            ],
          ]);
      }
      for (const cue of p.cues) {
        const parts = cue.parts.filter((part) => clip.shotIds.includes(part.shotId));
        if (!parts.length) continue;
        let offset = 0;
        const offsets = new Map<string, number>();
        for (const shot of videoClipShots(p, clip)) {
          offsets.set(shot.id, offset);
          offset += Math.round(shot.durationSeconds * 1000);
        }
        add(cue.kind === 'ON_SCREEN_TEXT' ? '画面文字安排' : '声音安排', [
          [
            '实际原文',
            cue.kind === 'ON_SCREEN_TEXT'
              ? videoCueText(p, cue)
              : parts
                  .map((part) =>
                    Array.from(videoCueText(p, cue)).slice(part.textStart, part.textEnd).join(''),
                  )
                  .join(''),
          ],
          [
            '本镜时间',
            parts
              .map(
                (part) =>
                  `${((offsets.get(part.shotId) ?? 0) + part.startMs) / 1000}–${((offsets.get(part.shotId) ?? 0) + part.endMs) / 1000} 秒`,
              )
              .join('、'),
          ],
        ]);
      }
    }
  } else if (step.id === 'PLAN') {
    const plan = saved.plan as
      | {
          summary: string;
          timing?: { explanation: string; estimatedSpeechSeconds: number; uncertainty: string };
          scenes?: { name: string; setting: string; spatialBaseline: string }[];
          clips?: {
            title: string;
            durationSeconds: number;
            startState: string;
            endState: string;
          }[];
        }
      | undefined;
    if (plan) {
      add('导演安排与容量', [
        ['实际安排', plan.summary],
        ['容量说明', plan.timing?.explanation],
        [
          '语音估时',
          plan.timing ? `${plan.timing.estimatedSpeechSeconds} 秒（文字估计）` : undefined,
        ],
        ['尚未验证', plan.timing?.uncertainty],
      ]);
      for (const scene of plan.scenes ?? [])
        add(scene.name, [
          ['场次', scene.setting],
          ['空间基准', scene.spatialBaseline],
        ]);
      for (const clip of plan.clips ?? [])
        add(clip.title, [
          ['规划时长', `${clip.durationSeconds} 秒`],
          ['开始状态', clip.startState],
          ['结束状态', clip.endState],
        ]);
    }
  } else if (step.id === 'REVIEW' || step.id === 'REPAIR') {
    const audit = (step.id === 'REPAIR' ? (saved.recheck ?? saved.audit) : saved.audit) as
      VideoAudit | undefined;
    if (audit) {
      for (const c of audit.checks) add(c.dimension, [['核对结论', prose(c.conclusion)]]);
      for (const f of audit.findings)
        add(`${f.severity === 'ERROR' ? '需修改' : '建议'} · ${prose(f.title)}`, [
          ['具体影响', prose(f.impact)],
          ['提示词原句', audit.promptEvidence?.find((q) => q.issueId === f.id)?.excerpt],
          ['实际依据', p ? f.evidence.map(evidenceText).filter(Boolean).join('\n') : undefined],
          ['修订建议', prose(f.suggestedFix)],
        ]);
      for (const r of audit.resolutions)
        add('原问题复核', [
          [
            '处理结果',
            ({ RESOLVED: '已解决', PARTIAL: '部分解决', UNRESOLVED: '尚未解决' } as const)[
              r.status
            ],
          ],
          ['结论', prose(r.explanation)],
          ['当前依据', p ? r.evidence.map(evidenceText).filter(Boolean).join('\n') : undefined],
        ]);
      for (const change of audit.severityChanges ?? [])
        add('审校定级说明', [
          [
            '级别调整',
            `${change.fromSeverity === 'ERROR' ? '需修改' : '建议'} → ${change.toSeverity === 'ERROR' ? '需修改' : '建议'}`,
          ],
          ['依据类型', change.reason === 'NEW_EVIDENCE' ? '修改后出现新证据' : '更正首次审校定级'],
          ['具体原因', prose(change.explanation)],
          [
            '当前证据',
            p ? change.evidence.map(evidenceText).filter(Boolean).join('\n') : undefined,
          ],
        ]);
    }
    if (step.id === 'REPAIR' && Array.isArray(saved.changes))
      for (const change of saved.changes as { label: string; before: string; after: string }[])
        add(change.label, [
          ['修改前', change.before],
          ['修改后', change.after],
        ]);
  } else if (p) {
    for (const clip of currentClips) {
      add(clip.title, [
        ['时长与镜头', `${videoClipMs(p, clip) / 1000} 秒 · ${clip.shotIds.length} 镜`],
        [
          input.operation === 'PROMPT' && prompt ? '提示词实际引用' : '分镜候选素材',
          (input.operation === 'PROMPT' && prompt ? prompt.assetIds : videoClipAssetIds(p, clip))
            .map((id) => input.document.assets.find((a) => a.id === id)?.name ?? '相关素材')
            .join('、'),
        ],
        ['衔接', clip.transition],
      ]);
      for (const [i, s] of videoClipShots(p, clip).entries())
        add(`镜头 ${i + 1} · ${s.title}`, [
          ['观看信息', s.information],
          ['画面', s.visual],
          ['镜头语言', `${s.shotType} · ${s.angle} · ${s.cameraMovement} · ${s.framing}`],
          ['时长', `${s.durationSeconds} 秒`],
          ['开始/结束', `${s.startState}\n→ ${s.endState}`],
          ['声音', s.audio],
        ]);
    }
    for (const cue of p.cues.filter((cue) =>
      currentClips.some((clip) => cue.parts.some((part) => clip.shotIds.includes(part.shotId))),
    ))
      add(cue.kind === 'ON_SCREEN_TEXT' ? '画面文字' : '原稿声音', [
        [
          '原文',
          input.operation === 'PROMPT' && cue.kind !== 'ON_SCREEN_TEXT'
            ? cue.parts
                .filter((part) => currentClips.some((clip) => clip.shotIds.includes(part.shotId)))
                .map((part) =>
                  Array.from(videoCueText(p, cue)).slice(part.textStart, part.textEnd).join(''),
                )
                .join('')
            : videoCueText(p, cue),
        ],
        ['说话者', cue.speaker],
      ]);
  }
  if (prompt?.content && ['GENERATE', 'REPAIR', 'SAVE'].includes(step.id))
    add('实际片段提示词', [['内容', prompt.content]]);
  return {
    title: step.title,
    summary: ['REVIEW', 'REPAIR'].includes(step.id) ? prose(step.content) : step.content,
    sections,
    emptyMessage: '此步骤尚未产生内容',
  };
}
