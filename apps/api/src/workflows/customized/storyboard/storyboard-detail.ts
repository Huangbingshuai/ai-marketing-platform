import {
  CUSTOMIZED_BRIEF_LABELS,
  isCommerceStrategy,
  isDramaStrategy,
  DRAMA_DEVELOPMENT_FIELDS,
  PRESENTER_APPROACH_FIELDS,
  storyboardStages,
  scriptStageRole,
  isSharedScriptStage,
  SCRIPT_PLAN_FIELDS,
  brandFactCatalog,
  BRAND_EXPRESSION_LABELS,
  CUSTOMIZED_VIDEO_TYPE_LABELS,
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
function readableShotText(value: unknown, script: unknown): string {
  let text = str(value);
  for (const [index, shot] of list(record(script).shots).entries()) {
    const id = str(record(shot).id);
    if (id)
      text = text.replace(
        new RegExp(
          `(?<![\\p{L}\\p{N}_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
          'gu',
        ),
        `镜头 ${index + 1}`,
      );
  }
  return text.replace(/\bshot[-_]0*(\d+)\b/gi, (match, number: string) => {
    const index = Number(number);
    return index > 0 && index <= list(record(script).shots).length ? `镜头 ${index}` : match;
  });
}
function readableObjectText(value: string, scripts: unknown[]): string {
  let text = value;
  const names = new Map<string, string>();
  for (const script of scripts) {
    for (const [index, beat] of list(record(script).beats).map(record).entries()) {
      const id = str(beat.id);
      // Scene headings are public screenplay labels, not opaque object identifiers.
      if (/^[SP]\d{2,}$/.test(id) && new RegExp(`^${id}[｜|]`).test(str(beat.content))) continue;
      if (id && !names.has(id)) names.set(id, `故事段落 ${index + 1}`);
    }
    for (const asset of list(record(script).assets).map(record)) {
      const id = str(asset.id),
        name = str(asset.name);
      if (id && name && !names.has(id)) names.set(id, name);
    }
  }
  for (const [id, name] of [...names].sort(([a], [b]) => b.length - a.length))
    text = text.replace(
      new RegExp(
        `(?<![A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`,
        'g',
      ),
      () => name,
    );
  // Proposed objects may not exist in either catalog yet. Do not invent their identity.
  return text
    .replace(/\b([SP])(\d+):E\d+\b/g, (_match, _prefix: string, index: string) => `篇章 ${Number(index)} 原文`)
    .replace(
      /\b(char|prod|scene)_[A-Za-z0-9_]+\b/g,
      (_id, kind: string) =>
        ({ char: '待定义人物对象', prod: '待定义产品对象', scene: '待定义场景对象' })[kind]!,
    )
    .replace(/\bassetRequirements\b/g, '资产关联')
    .replace(/\bshotIds\b/g, '关联镜头')
    .replace(/\bsynopsis\b/g, '剧情概述')
    .replace(/\bvisual\b/g, '画面内容')
    .replace(/\bBeat\s*(?=故事段落)/gi, '')
    .replace(/\bbeat\b/gi, '故事段落')
    .replace(/资产ID/g, '资产定义')
    .replace(/稳定ID/g, '稳定身份');
}
function review(v: unknown, script: unknown): Row[] {
  const r = record(v);
  const readable = (value: unknown) => readableShotText(value, script);
  const qualityLabels: Record<string, string> = {
    BUYING_REASON: '购买理由',
    VALUE_DEMONSTRATION: '价值呈现',
    INFORMATION_CAPACITY: '信息容量',
    VENUE_EVIDENCE: '真实场所依据',
    VISIT_EXPERIENCE: '到店体验',
    TRUSTWORTHY_DETAIL: '可信细节',
    VISIBLE_CONCEPT: '可见的视觉概念',
    VISUAL_PROGRESSION: '画面推进',
    BRAND_MEMORY: '品牌记忆',
    CHARACTER_CAUSALITY: '人物因果',
    NATURAL_DIALOGUE: '对白自然度',
    PRODUCT_CAUSALITY: '产品参与因果',
  };
  return [
    ...fields(r, { summary: '审校结论' }).map((row) => ({
      ...row,
      content: readable(row.content),
    })),
    ...list(r.qualityChecks).map((value) => {
      const check = record(value);
      const status =
        check.verdict === 'FAIL' ? '需修订' : check.verdict === 'PASS' ? '通过' : '不适用';
      return {
        title: `${qualityLabels[str(check.criterion)] ?? '创作质量'} · ${status}`,
        content: [
          list(check.beatIds).map(str).join('、'),
          str(check.evidence),
          str(check.reason),
          str(check.suggestion),
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }),
    ...list(r.findings).map((f) => {
      const x = record(f);
      return {
        title: readable(x.message),
        content: [
          list(x.beatIds).map(str).join('、'),
          list(x.shotIds)
            .map((id) => {
              const i = list(record(script).shots).findIndex((s) => record(s).id === id);
              return i >= 0
                ? `镜头 ${i + 1} · ${str(record(list(record(script).shots)[i]).title)}`
                : '整体脚本';
            })
            .join('、'),
          readable(x.evidence),
          readable(x.suggestion),
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
  const role = scriptStageRole(nodeId);
  const shared = isSharedScriptStage(nodeId),
    chosen = steps.filter(
      (s) =>
        s.nodeId === nodeId && (shared ? s.scriptId === '' : !scriptId || s.scriptId === scriptId),
    );
  const stage = storyboardStages(input).find((s) => s.id === nodeId)!;
  const conceptStep = steps.find((s) => scriptStageRole(s.nodeId) === 'CONCEPT');
  const concepts = list(record(conceptStep?.output).concepts).map(record);
  const outputs = chosen.flatMap((s) => {
    const o = record(s.output),
      prefix = concepts.find((c) => c.scriptId === s.scriptId)?.name;
    let rows: Row[] = [];
    const brandFacts = brandFactCatalog(input.brief);
    const factText = (refs: unknown) => list(refs).map(id => brandFacts.find(f => f.id === id)?.text ?? '').filter(Boolean).join('\n');
    if (nodeId === 'BRAND_AD_PROPOSITION') {
      rows = fields(o.proposition, { message: '主要传播命题', audienceObservation: '受众观察', requiredReason: '必须展示信息的判断' });
      const proposition = record(o.proposition);
      if (proposition.observationBasis) rows.push({ title: '观察依据', content: proposition.observationBasis === 'BRIEF' ? '来自已确认简报' : '用于创作探索的假设，未经受众调研验证' });
      rows.push({ title: '产品依据', content: factText(proposition.supportingFactIds) });
      if (list(proposition.requiredFactIds).length) rows.push({ title: '明确需要展示的信息', content: factText(proposition.requiredFactIds) });
    }
    if (nodeId === 'BRAND_AD_IDEAS') rows = list(o.ideas).map(record).map(idea => ({
      title: str(idea.name), content: [BRAND_EXPRESSION_LABELS[str(idea.approach)],
        ...fields(idea, { viewingHook: '观看吸引点', mechanism: '表达方式', keyImages: '关键画面', productRole: '产品参与', memory: '品牌记忆', risk: '需要警惕的问题' }).map(r => `${r.title}：${r.content}`),
        `产品依据：${factText(idea.factIds)}`].filter(Boolean).join('\n'),
    }));
    if (nodeId === 'ECOMMERCE_MOTIVATION') {
      rows = fields(record(o.readiness), { reason: '策划依据', missing: '需要补充的产品依据' });
      rows.push(...list(o.opportunities).map(record).map(opportunity => {
        const demo = record(opportunity.demonstration);
        return { title: str(opportunity.name), content: [
          ...fields(opportunity, { audienceSituation: '适用处境', buyingReason: '购买理由', purchaseQuestion: '回应的购买疑问', creativeIdea: '具体创意', progression: '内容推进', ending: '收束' }).map(r => `${r.title}：${r.content}`),
          ...fields(opportunity.approach, PRESENTER_APPROACH_FIELDS).map(r => `${r.title}：${r.content}`),
          opportunity.situationBasis === 'CREATIVE_HYPOTHESIS' ? '处境依据：创作假设，未经受众调研验证' : '处境依据：已确认简报',
          ...fields(demo, { setup: '演示起点', action: '实际过程', observableResult: '可观察结果', claimBoundary: '表达边界' }).map(r => `${r.title}：${r.content}`),
          `产品依据：${factText(opportunity.factIds)}`,
        ].join('\n') };
      }));
    }
    if (nodeId === 'SNAPSHOT' && s.output) rows = fields(input.brief, CUSTOMIZED_BRIEF_LABELS);
    if (role === 'CONCEPT')
      rows = list(o.concepts).flatMap((c) =>
        fields(c, {
          name: '方案名称',
          synopsis: ['VIDEO_SCRIPT_V2', 'VIDEO_SCRIPT_V3'].includes(input.storyFormat ?? '')
            ? '方案概述'
            : '故事切入',
          productFocus: '产品关联',
          structure: ['VIDEO_SCRIPT_V2', 'VIDEO_SCRIPT_V3'].includes(input.storyFormat ?? '')
            ? '脚本结构'
            : '叙事发展',
          difference: '方案差异',
          coreIdea: '核心创意',
          openingHook: '开场吸引点',
          productRole: '产品参与方式',
          memoryPoint: '记忆点',
        }),
      );
    if (role === 'CONCEPT' && input.routeId) {
      const readiness = record(o.readiness);
      rows.push(...fields(readiness, { reason: '资料充分性判断', missing: '需要补充的依据' }));
      for (const c of list(o.concepts).map(record))
        rows.push(
          ...fields(c.plan, SCRIPT_PLAN_FIELDS[input.routeId]).map((r) => ({
            ...r,
            title: `${str(c.name)} · ${r.title}`,
          })),
        );
    }
    if (nodeId === 'DRAMA_CONCEPT' && isDramaStrategy(input.strategyVersions?.concept)) {
      const development = record(o.development ?? record(o.redevelopmentResult ?? o.developmentResult).value);
      const ideas = list(development.ideas).map(record);
      const decision = o.status ? o : record(record(o.secondSelectionResult ?? o.selectionResult).value);
      const readable = (text: string) => ideas.reduce((result, idea) => result.replaceAll(str(idea.id), str(idea.name)), text);
      rows = fields(development.readiness, {reason:'资料充分性判断',missing:'需要补充的依据'});
      rows.push(...ideas.map(idea => ({title:`候选故事 · ${str(idea.name)}`, content:[
        `创作手法：${list(idea.devices).map(str).join('、')}`,
        ...fields(idea, DRAMA_DEVELOPMENT_FIELDS).map(r => `${r.title}：${r.content}`),
        ...fields(idea.plan, SCRIPT_PLAN_FIELDS.DRAMA).map(r => `${r.title}：${r.content}`),
        `产品依据：${factText(idea.factIds)}`,
      ].join('\n')})));
      rows.push(...fields(decision, {reason:'独立择优结论',missing:'需要补充的依据'}));
      rows.push(...list(decision.evaluations).map(record).map(e => ({
        title:`${str(ideas.find(i => i.id === e.ideaId)?.name)} · ${e.verdict === 'ADVANCE' ? '适合展开' : '本次不采用'}`,
        content:readable(str(e.reason)),
      })));
      rows.push(...list(decision.choices).map(record).map(c => ({
        title:`${str(ideas.find(i => i.id === c.ideaId)?.name)} · 正文需要兑现`,
        content:list(c.mustPreserve).map(str).join('\n'),
      })));
      rows.push(...fields(o.initialSelection ?? record(o.selectionResult).value, {reason:'原组候选取舍依据'}));
      rows = rows.map(row => ({...row, content:readable(row.content)}));
    }
    if (nodeId === 'ECOMMERCE_CONCEPT' && isCommerceStrategy(input.strategyVersions?.concept)) {
      const source = record(o.redevelopment ?? steps.find(v => v.nodeId === 'ECOMMERCE_MOTIVATION')?.output);
      const opportunities = list(source.opportunities).map(record);
      const decision = o.status ? o : record(record(o.secondSelection ?? o.selection).value);
      rows = fields(decision, { reason: '独立择优结论', missing: '需要补充的依据' });
      rows.push(...list(decision.choices).map(record).map(c => {
        const opportunity = record(opportunities.find(v => v.id === c.opportunityId));
        return { title: `${str(opportunity.name)} · 需要兑现的演示`, content: [
          ...fields(opportunity, { audienceSituation: '适用处境', buyingReason: '购买理由', purchaseQuestion: '购买疑问', creativeIdea: '具体创意' }).map(r => `${r.title}：${r.content}`),
          ...fields(opportunity.approach, PRESENTER_APPROACH_FIELDS).map(r => `${r.title}：${r.content}`),
          ...fields(opportunity.demonstration, { setup: '演示起点', action: '实际过程', observableResult: '可观察结果', claimBoundary: '表达边界' }).map(r => `${r.title}：${r.content}`),
          ...list(c.mustPreserve).map(str), `产品依据：${factText(opportunity.factIds)}`,
        ].join('\n') };
      }));
      rows.push(...list(decision.evaluations).map(record).map(e => ({
        title: `${str(opportunities.find(v => v.id === e.opportunityId)?.name)} · ${e.verdict === 'ADVANCE' ? '适合展开' : '本次不采用'}`,
        content: str(e.reason),
      })));
      if (o.redevelopment) {
        rows.push(...fields(record(o.initialSelection), { reason: '原组候选未采用的原因' }));
        rows.push(...opportunities.map(v => ({ title: `替代方案 · ${str(v.name)}`, content: `${str(v.buyingReason)}\n${str(record(v.demonstration).observableResult)}` })));
      }
    }
    if (nodeId === 'BRAND_AD_CONCEPT' && ['2026-10-14.1','2026-10-14.2', '2026-10-14.3', '2026-10-14.4', '2026-10-14.5', '2026-10-14.6', '2026-10-14.7'].includes(input.strategyVersions?.concept ?? '')) {
      const decision = o.status ? o : record(o.secondSelection ?? o.selection);
      const development = record(o.redevelopment ?? steps.find(v => v.nodeId === 'BRAND_AD_IDEAS')?.output);
      const ideas = list(development.ideas).map(record);
      rows.push(...fields(decision, { reason: '独立择优结论', missing: '需补充依据' }));
      rows.push(...list(decision.evaluations).map(record).map(e => ({
        title: `${str(ideas.find(i => i.id === e.ideaId)?.name)} · ${e.verdict === 'ADVANCE' ? '适合展开' : '本次不采用'}`,
        content: `${str(e.reason)}\n观看吸引力 ${str(e.attraction)}/5 · 产品关联 ${str(e.productConnection)}/5 · 表达清晰度 ${str(e.clarity)}/5 · 方案区别 ${str(e.distinctiveness)}/5`,
      })));
      rows.push(...list(decision.commitments).map(record).map(c => ({
        title: `${str(list(decision.concepts).map(record).find(v => v.scriptId === c.scriptId)?.name)} · 创意保留清单`,
        content: `${BRAND_EXPRESSION_LABELS[str(c.approach)] ?? ''}\n${list(c.mustPreserve).map(str).join('\n')}\n必要产品依据：${factText(c.essentialFactIds)}`,
      })));
      if (o.redevelopment) {
        rows.push(...fields(record(o.initialSelection), {reason:'原组候选未采用的原因'}));
        rows.push(...fields(development.proposition, {message:'替代传播命题', audienceObservation:'替代受众观察'}));
      }
      if (o.redevelopment) rows.push(...list(development.ideas).map(record).map(i => ({ title: `替代短创意 · ${str(i.name)}`, content: `${str(i.viewingHook)}\n${str(i.mechanism)}\n${list(i.keyImages).map(str).join('\n')}` })));
    }
    if (nodeId === 'PREPARE' && s.output)
      rows = [
        ...fields(o.brief, CUSTOMIZED_BRIEF_LABELS),
        ...list(o.requirements).map((r, i) => ({
          title: `结构要求 ${i + 1}`,
          content: str(record(r).title),
        })),
      ];
    if (nodeId === 'ROUTE' && s.output && input.routeId)
      rows = [
        {
          title: '本次创作线路',
          content: `${CUSTOMIZED_VIDEO_TYPE_LABELS[input.routeId]}：本批全部方案沿此线路构思、写作和审校。`,
        },
      ];
    if (role === 'STORY')
      rows = fields(o, {
        title: input.storyFormat ? '剧本名称' : '故事名称',
        content: input.storyFormat ? '剧本正文' : '完整故事',
        opening: '开场',
        development: '发展',
        ending: '收束',
        dialoguePlan: '对白安排',
      });
    if (role === 'STORY')
      for (const [i, mapping] of list(o.structureMapping).map(record).entries())
        rows.push({
          title: `结构落实 · ${input.settings.structureSections?.[i] ?? ''}`,
          content: `${list(mapping.beatIds).map(str).join('、')}
${str(mapping.evidence)}`,
        });
    if (nodeId === 'RECHECK' && s.status === 'SKIPPED')
      rows = [{ title: '无需复核', content: '正文未修订，沿用专项审校结论。' }];
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
    if (nodeId === 'SHOTS') {
      const assets = steps.find((v) => v.nodeId === 'ASSETS' && v.scriptId === s.scriptId)?.output;
      rows = shots(
        o.shots
          ? o
          : {
              shots: list(o.chunks).flatMap((c) => list(record(c).shots)),
              assets: record(assets).assets,
            },
      );
      const rejected = record(o.rejectedChunk);
      for (const issue of list(rejected.issues).map(record)) {
        if (issue.code === 'DURATION_SUM')
          rows.push({
            title: '片段时长待纠正',
            content: `本片段目标 ${str(issue.expected)} 秒，当前镜头合计 ${str(issue.actual)} 秒。${rejected.correctionComplete ? '自动纠正仍未通过，当前脚本尚未发布。' : '将保留合理内容，自动纠正时长。'}`,
          });
        if (issue.code === 'SHOT_IDS_OR_ASSET_REFERENCES')
          rows.push({
            title: '镜头引用待纠正',
            content: '检测到重复镜头标识或不属于对象目录的引用，当前片段尚未采用。',
          });
      }
    }
    if (role === 'REVIEW' || (nodeId === 'RECHECK' && s.status !== 'SKIPPED'))
      rows = review(
        o,
        steps.find((v) => v.nodeId === 'SHOTS' && v.scriptId === s.scriptId)?.output,
      );
    if (nodeId === 'REPAIR')
      rows =
        s.status === 'SKIPPED'
          ? [{ title: '无需修订', content: '独立审校未发现需要修订的问题。' }]
          : [
              ...fields(o, { reason: '修改原因' }).map((row) => ({
                ...row,
                content: readableShotText(row.content, o.script),
              })),
              ...list(o.changes).flatMap((c) =>
                fields(c, { before: '修改前', after: '修改后', reason: '修改依据' }).map((row) => ({
                  ...row,
                  content: readableShotText(row.content, o.script),
                })),
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
    const catalogs = [
      steps.find((v) => v.nodeId === 'SHOTS' && v.scriptId === s.scriptId)?.output,
      record(steps.find((v) => v.nodeId === 'REPAIR' && v.scriptId === s.scriptId)?.output).script,
      steps.find((v) => v.nodeId === 'ASSETS' && v.scriptId === s.scriptId)?.output,
      steps.find((v) => scriptStageRole(v.nodeId) === 'STORY' && v.scriptId === s.scriptId)?.output,
    ];
    const candidateIds = list(record(steps.find(v => v.nodeId === 'BRAND_AD_IDEAS')?.output).ideas).map(record);
    const readableBrandText = (text: string) => {
      let result = text.replace(/CREATIVE_HYPOTHESIS[：:]?\s*/g, '创作假设：');
      for (const [index, idea] of candidateIds.entries()) {
        const id = str(idea.id);
        if (id) result = result.split(id).join(`候选创意 ${index + 1}`);
      }
      const development = record(record(conceptStep?.output).redevelopment ?? steps.find(v => v.nodeId === 'ECOMMERCE_MOTIVATION')?.output);
      for (const opportunity of list(development.opportunities).map(record)) {
        const id = str(opportunity.id), name = str(opportunity.name);
        if (id && name) result = result.replace(new RegExp(`(?<![A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'g'), () => `“${name}”`);
      }
      return result;
    };
    return rows.map((r) => ({
      title: readableObjectText(
        prefix && prefix !== r.title ? `${str(prefix)} · ${r.title}` : r.title,
        catalogs,
      ),
      content: readableBrandText(readableObjectText(r.content, catalogs)),
    }));
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
            content: `信息卡版本 ${input.source.revision} · ${['VIDEO_SCRIPT_V2', 'VIDEO_SCRIPT_V3'].includes(input.storyFormat ?? '') ? '参考' : '目标'} ${input.settings.targetDurationSeconds} 秒\n${input.settings.videoType ? CUSTOMIZED_VIDEO_TYPE_LABELS[input.settings.videoType] : ''}\n${input.settings.structureMode === 'AI' ? '脚本结构由系统编排' : input.settings.structureSections?.join(' → ') || input.settings.structure}${['VIDEO_SCRIPT_V2', 'VIDEO_SCRIPT_V3'].includes(input.storyFormat ?? '') ? '' : `\n${input.settings.instructions}`}`,
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
                ? outputs.length
                  ? '等待继续执行，已保存内容显示在下方'
                  : '等待执行，尚无生成结果'
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
