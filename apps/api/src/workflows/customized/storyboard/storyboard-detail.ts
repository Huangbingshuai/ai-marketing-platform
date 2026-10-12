import {
  CUSTOMIZED_BRIEF_LABELS,
  CUSTOMIZED_STORYBOARD_STAGES,
  type StoryboardDetail,
  type StoryboardInput,
  type StoryboardStage,
} from '@ai-marketing/contracts';

type Row = { title: string; content: string };
type Step = {
  nodeId: string;
  scriptId: string;
  status: string;
  output: unknown;
  errorMessage: string | null;
  updatedAt: Date;
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';
const fields = (v: unknown, labels: Record<string, string>): Row[] =>
  Object.entries(labels).flatMap(([key, title]) => {
    const value = record(v)[key];
    const content = Array.isArray(value) ? value.map(str).join('\n') : str(value);
    return content ? [{ title, content }] : [];
  });
function shots(v: unknown): Row[] {
  const script = record(v),
    assets = list(script.assets).map(record);
  return list(script.shots).map((shot, index) => {
    const s = record(shot),
      groups = record(s.assetRequirements);
    const refs = Object.entries({ characters: '人物', products: '产品', scenes: '场景' }).map(
      ([kind, label]) => {
        const group = record(groups[kind]);
        return `${label}：${
          group.state === 'NONE'
            ? '本镜不需要'
            : list(group.items)
                .map((item) => {
                  const r = record(item);
                  return `${str(assets.find((a) => a.id === r.assetId)?.name)}${r.description ? `（${str(r.description)}）` : ''}`;
                })
                .join('、') || '待定义'
        }`;
      },
    );
    return {
      title: `镜头 ${index + 1} · ${str(s.title)}`,
      content: [
        `${str(s.shotType)} · ${str(s.cameraMovement)} · ${str(s.durationSeconds)} 秒`,
        str(s.visual),
        ...list(s.dialogues).map((d) => `${str(record(d).speaker)}：${str(record(d).text)}`),
        str(s.audio),
        str(s.continuity),
        ...refs,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });
}
function review(v: unknown, script: unknown): Row[] {
  const r = record(v);
  return [
    ...fields(r, { summary: '审校结论' }),
    ...list(r.findings).map((f) => {
      const x = record(f);
      return {
        title: str(x.message),
        content: [
          list(x.shotIds)
            .map((id) => {
              const i = list(record(script).shots).findIndex((s) => record(s).id === id);
              return i >= 0
                ? `镜头 ${i + 1} · ${str(record(list(record(script).shots)[i]).title)}`
                : '整体脚本';
            })
            .join('、'),
          str(x.evidence),
          str(x.suggestion),
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }),
  ];
}
export function storyboardDetail(
  input: StoryboardInput,
  steps: Step[],
  nodeId: StoryboardStage,
  scriptId?: string,
  page = 0,
): StoryboardDetail {
  const shared = ['SNAPSHOT', 'CONCEPT'].includes(nodeId),
    chosen = steps.filter(
      (s) =>
        s.nodeId === nodeId && (shared ? s.scriptId === '' : !scriptId || s.scriptId === scriptId),
    );
  const stage = CUSTOMIZED_STORYBOARD_STAGES.find((s) => s.id === nodeId)!;
  const conceptStep = steps.find((s) => s.nodeId === 'CONCEPT');
  const concepts = list(record(conceptStep?.output).concepts).map(record);
  const outputs = chosen.flatMap((s) => {
    const o = record(s.output),
      prefix = concepts.find((c) => c.scriptId === s.scriptId)?.name;
    let rows: Row[] = [];
    if (nodeId === 'SNAPSHOT' && s.output) rows = fields(input.brief, CUSTOMIZED_BRIEF_LABELS);
    if (nodeId === 'CONCEPT')
      rows = list(o.concepts).flatMap((c) =>
        fields(c, {
          name: '方案名称',
          synopsis: '故事切入',
          productFocus: '产品关联',
          structure: '叙事发展',
          difference: '方案差异',
        }),
      );
    if (nodeId === 'STORY')
      rows = fields(o, {
        title: '故事名称',
        content: '完整故事',
        opening: '开场',
        development: '发展',
        ending: '收束',
        dialoguePlan: '对白安排',
      });
    if (nodeId === 'ASSETS') {
      const script = record(
        steps.find((v) => v.nodeId === 'SHOTS' && v.scriptId === s.scriptId)?.output,
      );
      rows = list(o.assets).map((value) => {
        const asset = record(value);
        const positions = list(script.shots).flatMap((value, index) => {
          const shot = record(value),
            group = record(record(shot.assetRequirements)[str(asset.kind)]);
          return list(group.items).some((r) => record(r).assetId === asset.id)
            ? [`镜头 ${index + 1} · ${str(shot.title)}`]
            : [];
        });
        const kind =
          ({ characters: '人物', products: '产品', scenes: '场景' } as Record<string, string>)[
            str(asset.kind)
          ] ?? '对象';
        return {
          title: `${kind} · ${str(asset.name)}`,
          content: `${str(asset.description)}\n使用位置：${positions.join('、') || (script.shots ? '当前镜头未使用' : '镜头完成后显示实际使用位置')}`,
        };
      });
    }
    if (nodeId === 'SHOTS') rows = shots(o);
    if (nodeId === 'REVIEW')
      rows = review(
        o,
        steps.find((v) => v.nodeId === 'SHOTS' && v.scriptId === s.scriptId)?.output,
      );
    if (nodeId === 'REPAIR')
      rows =
        s.status === 'SKIPPED'
          ? [{ title: '无需修订', content: '独立审校未发现需要修订的问题。' }]
          : [
              ...fields(o, { reason: '修改原因' }),
              ...list(o.changes).flatMap((c) =>
                fields(c, { before: '修改前', after: '修改后', reason: '修改依据' }),
              ),
              ...review(o.review, o.script),
              ...shots(o.script),
            ];
    if (nodeId === 'SAVE' && s.status === 'SUCCEEDED')
      rows = [
        {
          title: str(o.name),
          content: `脚本已保存，可在方案列表中打开；来源信息卡版本 ${input.source.revision}。`,
        },
      ];
    if (s.errorMessage) rows.push({ title: '本阶段未完成', content: s.errorMessage });
    return rows.map((r) => ({ ...r, title: prefix ? `${str(prefix)} · ${r.title}` : r.title }));
  });
  const state = chosen.some((s) => s.status === 'RUNNING')
    ? 'RUNNING'
    : chosen.some((s) => s.status === 'FAILED')
      ? 'FAILED'
      : chosen.length && chosen.every((s) => ['SUCCEEDED', 'SKIPPED'].includes(s.status))
        ? 'SUCCEEDED'
        : 'PENDING';
  const visible = outputs.slice(page * 20, (page + 1) * 20);
  return {
    nodeId,
    status: state,
    summary: stage.description,
    updatedAt: chosen.length
      ? new Date(Math.max(...chosen.map((s) => s.updatedAt.getTime()))).toISOString()
      : null,
    page,
    hasMore: outputs.length > (page + 1) * 20,
    sections: [
      {
        kind: 'INPUT',
        title: '创作依据',
        items: [
          {
            title: input.brief.productName,
            content: `信息卡版本 ${input.source.revision} · 目标 ${input.settings.targetDurationSeconds} 秒\n${input.settings.structureMode === 'AI' ? '叙事结构由 AI 设计' : input.settings.structure}\n${input.settings.instructions}`,
          },
        ],
      },
      {
        kind: 'EXECUTION',
        title: '执行情况',
        items: [
          {
            title: stage.label,
            content:
              state === 'PENDING'
                ? '等待执行，尚无生成结果'
                : state === 'RUNNING'
                  ? '正在处理，已保存内容显示在下方'
                  : state === 'FAILED'
                    ? '执行未完成，可恢复重试'
                    : '本阶段已完成',
          },
        ],
      },
      { kind: 'OUTPUT', title: '实际结果', items: visible },
    ],
  };
}
