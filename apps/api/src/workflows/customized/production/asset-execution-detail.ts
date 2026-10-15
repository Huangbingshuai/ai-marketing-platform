import {
  ASSET_FIELD_LABELS,
  isProductionAsset,
  type ProductionAsset,
  type ProductionExecutionDetail,
  type ProductionInput,
  type ProductionStep,
} from '@ai-marketing/contracts';

type Row = Record<string, unknown>;
type Section = ProductionExecutionDetail['sections'][number];
const row = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(row) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const kindNames: Record<string, string> = {
  PRODUCT: '产品',
  CHARACTER: '人物',
  SCENE: '场景',
  PROP: '道具',
};
const fields = (values: [string, unknown][]) =>
  values.flatMap(([label, value]) => (text(value).trim() ? [{ label, value: text(value) }] : []));
const section = (title: string, values: [string, unknown][]): Section => ({
  title,
  fields: fields(values),
});
const assets = (v: unknown): ProductionAsset[] =>
  Array.isArray(v) ? v.filter(isProductionAsset) : [];
function definition(a: ProductionAsset): Section {
  return section(a.name, [
    ['故事中的作用', a.preparation?.usage],
    ['公共形象', a.description],
    ['资料已明确', a.knownFacts],
    ['创作设定与待确认内容', a.designNotes],
    ...(a.preparation?.details.map(
      (d) => [ASSET_FIELD_LABELS[d.key] ?? '形象特征', d.value] as [string, unknown],
    ) ?? []),
    [
      '制作前需确认',
      a.preparation?.questions.map((q) => `${q.question}\n影响：${q.impact}`).join('\n\n'),
    ],
  ]);
}
function preparationText(value: unknown): string {
  const p = row(value);
  return fields([
    ['其他称呼', strings(p.aliases).join('、')],
    ['故事中的作用', p.usage],
    ...rows(p.details).map(
      (d) => [ASSET_FIELD_LABELS[text(d.key)] ?? '形象特征', d.value] as [string, unknown],
    ),
    [
      '待确认',
      rows(p.questions)
        .map((q) => text(q.question))
        .filter(Boolean)
        .join('；'),
    ],
    [
      '图片要求',
      rows(p.images)
        .map((i) => `${text(i.name)}：${text(i.purpose)}\n${text(i.requirements)}`)
        .join('\n'),
    ],
    [
      '原文依据',
      rows(p.sources)
        .map((s) => text(s.quote))
        .filter(Boolean)
        .join('\n'),
    ],
  ])
    .map((f) => `${f.label}：${f.value}`)
    .join('\n');
}

/** Project persisted business results only; never return raw checkpoints, IDs, paths or model configuration. */
export function assetExecutionDetail(
  step: ProductionStep,
  input: ProductionInput,
  output: unknown,
): ProductionExecutionDetail | undefined {
  if (input.operation !== 'ASSETS') return undefined;
  const saved = row(output);
  const inventory = rows(saved.inventory);
  const batches = Object.values(row(saved.batches)).flatMap(assets);
  const generated = batches.length ? batches : assets(row(saved.value).assets);
  const revised = assets(saved.revised);
  const final = assets(row(saved.final).assets);
  const current = final.length ? final : revised.length ? revised : generated;
  const names = new Map(
    [...input.document.assets, ...generated, ...revised, ...current].map((a) => [a.id, a.name]),
  );
  for (const a of inventory) names.set(text(a.id), text(a.name));
  const objectName = (id: unknown) => names.get(text(id)) || '相关对象';
  const briefLabels: Record<string, string> = {
    brandName: '品牌名称',
    projectName: '项目名称',
    projectBackground: '项目背景',
    brandTone: '品牌调性',
    visualConsistencyRules: '视觉统一规则',
    avoidedElements: '画面禁用元素',
    productName: '产品名称',
    productDescription: '产品介绍',
    productSpecifications: '产品规格',
    productAppearance: '产品外观',
    sellingPoints: '核心卖点',
    targetAudience: '目标受众',
  };
  const businessText = (value: string): string => {
    let display = value;
    for (const [id, name] of [...names].sort((a, b) => b[0].length - a[0].length))
      if (id) display = display.split(id).join(name);
    return display
      .replace(
        /BRIEF\s+\/([A-Za-z]+)(?:\/\d+)?/g,
        (_, field: string) => `信息卡「${briefLabels[field] ?? '相关资料'}」`,
      )
      .replace(
        /SCRIPT\s+\/story\/beats\/(\d+)(?:\/[A-Za-z]+)?/g,
        (_, index: string) => `脚本「叙事段落 ${Number(index) + 1}」`,
      )
      .replace(/SCRIPT\s+\/story\/content/g, '脚本「故事正文」')
      .replace(/\bBRIEF\b/g, '信息卡')
      .replace(/\bSCRIPT\b/g, '脚本')
      .replace(
        /(?:preparation\.)?details\.([A-Za-z]+)/g,
        (_, field: string) => ASSET_FIELD_LABELS[field] ?? '分类特征',
      )
      .replace(/\bpreparation\.details\b/g, '分类特征')
      .replace(
        /\b(knownFacts|designNotes|imageRequirements|preparation)\b/g,
        (field) => ASSET_FIELD_LABELS[field] ?? '分类定义',
      )
      .replace(/\bREQUIRED\b/g, '需修正')
      .replace(/\bSUGGESTION\b/g, '优化建议')
      .replace(/\bquestions\b/g, '待确认事项')
      .replace(/\basset-(?:\.{3}|…)-\d+\b/g, '相关对象')
      .replace(/\basset-\d+\b/g, '相关对象');
  };
  const result = (
    title: string,
    summary: string,
    sections: Section[],
    emptyMessage?: string,
  ): ProductionExecutionDetail => ({
    title: businessText(title),
    summary: businessText(summary),
    sections: sections
      .filter((s) => s.fields.length)
      .map((s) => ({
        ...s,
        title: businessText(s.title),
        fields: s.fields.map((f) => ({
          ...f,
          label: businessText(f.label),
          value: businessText(f.value),
        })),
      })),
    ...(emptyMessage ? { emptyMessage: businessText(emptyMessage) } : {}),
  });
  const waiting =
    step.status === 'FAILED'
      ? '这一步尚未完成，已整理的内容会保留。'
      : step.status === 'RUNNING'
        ? '正在整理，已完成的内容会陆续显示。'
        : '执行到这一步后，将展示具体内容。';

  if (step.id === 'SNAPSHOT') {
    const b = row(input.brief);
    return result(
      '本次依据的故事与产品资料',
      input.targetAssetId
        ? `本次只重新整理「${objectName(input.targetAssetId)}」，其他资产保持原样。`
        : '按当前脚本识别实际出场对象，产品特征以已确认信息卡为依据。',
      [
        section(input.script.name, [
          ['故事正文', input.script.story?.content || input.script.synopsis],
          ['产品呈现重点', input.script.productFocus],
        ]),
        section('产品信息', [
          ['产品名称', b.productName],
          ['产品介绍', b.productDescription],
          ['产品规格', b.productSpecifications],
          ['产品外观', b.productAppearance],
          ['核心卖点', strings(b.sellingPoints).join('\n')],
        ]),
        section('品牌与画面要求', [
          ['品牌名称', b.brandName],
          ['品牌调性', b.brandTone],
          ['视觉统一规则', b.visualConsistencyRules],
          ['画面禁用元素', b.avoidedElements],
        ]),
      ],
    );
  }
  if (step.id === 'INVENTORY') {
    return result(
      '故事里需要准备哪些对象',
      '逐项说明对象在故事中的作用，并保留对应原文，便于核对是否遗漏或误认。',
      inventory.map((a) =>
        section(text(a.name), [
          ['对象类型', kindNames[text(a.kind)]],
          ['在故事中的作用', a.usage],
          ['其他称呼', strings(a.aliases).join('、')],
          [
            '原文依据',
            rows(a.sources)
              .map((s) => `${s.source === 'BRIEF' ? '信息卡' : '脚本'}：${text(s.quote)}`)
              .join('\n\n'),
          ],
        ]),
      ),
      waiting,
    );
  }
  if (step.id === 'IDENTITY') {
    const included = new Set(inventory.map((a) => text(a.id)));
    return result(
      '哪些是同一对象，哪些需要单独准备',
      '复用已有对象的身份，说明附属物如何随人物或场景一起制作。',
      [
        ...inventory.map((a) =>
          section(text(a.name), [
            [
              '身份处理',
              a.existingId
                ? '沿用已有对象，保留原有图片与人工修改。'
                : '作为本次故事的新对象建立定义。',
            ],
            [
              '制作安排',
              a.treatment === 'INDEPENDENT'
                ? '独立准备参考形象。'
                : a.treatment === 'SCENE_DETAIL'
                  ? `作为「${objectName(a.parentId)}」的场景细节一起准备。`
                  : `作为「${objectName(a.parentId)}」的人物造型一起准备。`,
            ],
            ['其他称呼', strings(a.aliases).join('、')],
          ]),
        ),
        ...(inventory.length
          ? input.document.assets
              .filter((a) => !included.has(a.id))
              .map((a) =>
                section(a.name, [
                  ['原有内容', '本次没有重新整理此对象，原定义、图片和已有镜头引用继续保留。'],
                ]),
              )
          : []),
      ],
      waiting,
    );
  }
  if (kindNames[step.id] || step.id === 'GENERATE') {
    // Category nodes show their own generated definition, before subsequent repair.
    const category =
      step.id === 'GENERATE' ? generated : generated.filter((a) => a.kind === step.id);
    return result(
      step.id === 'GENERATE' ? '本次整理的共用形象' : `${kindNames[step.id]}的具体形象与制作条件`,
      '已明确的特征与允许创作的设定分开展示；资料不足的地方保留待确认。',
      category.map(definition),
      step.status === 'SUCCEEDED' ? '当前故事无需单独准备此类对象。' : waiting,
    );
  }
  if (step.id === 'IMAGE_PLAN') {
    return result(
      '后续需要制作哪些参考图',
      '这里整理图片的用途与具体要求；实际图片可以在后续按镜头需要准备。',
      generated.map((a) =>
        section(a.name, [
          ...(a.preparation?.images.length
            ? a.preparation.images.map(
                (i) => [i.name, `${i.purpose}\n${i.requirements}`] as [string, unknown],
              )
            : ([['图片安排', a.imageRequirements || '暂不需要独立制作图片。']] as [
                string,
                unknown,
              ][])),
          [
            '制作前需确认',
            a.preparation?.questions.map((q) => `${q.question}\n影响：${q.impact}`).join('\n\n'),
          ],
        ]),
      ),
      waiting,
    );
  }
  if (step.id === 'PLAN')
    return result(
      '共用资产的制作安排',
      text(row(saved.plan).summary),
      [],
      text(row(saved.plan).summary) ? undefined : waiting,
    );
  if (step.id === 'REVIEW') {
    const audit = row(saved.audit);
    return result(
      '资产定义有哪些问题需要处理',
      text(audit.summary),
      rows(audit.findings)
        .map((f) =>
          section(objectName(f.assetId), [
            ['检查内容', ASSET_FIELD_LABELS[text(f.field)]],
            ['发现的问题', f.issue],
            ['判断依据', f.basis],
            [
              '处理建议',
              f.severity === 'REQUIRED' ? '需要修正后再完成整理。' : '作为优化建议保留。',
            ],
          ]),
        )
        .concat(
          strings(audit.issues).map((issue) => section('需核对的问题', [['具体问题', issue]])),
        ),
      text(audit.summary) ? '审校没有提出需要修改的具体问题。' : waiting,
    );
  }
  if (step.id === 'REPAIR') {
    const audit = row(saved.audit),
      recheck = row(saved.recheck);
    const patches = rows(row(saved.patches).patches);
    const changes = patches.map((p) => {
      const before = generated.find((a) => a.id === p.assetId);
      const finding = rows(audit.findings).find(
        (f) => f.assetId === p.assetId && f.field === p.field,
      );
      const key = text(p.field) as keyof ProductionAsset;
      return section(`${objectName(p.assetId)} · ${ASSET_FIELD_LABELS[key] ?? '相关内容'}`, [
        ['为什么修改', finding?.issue],
        ['依据', finding?.basis],
        ['修改前', key === 'preparation' ? preparationText(before?.preparation) : before?.[key]],
        ['修改后', key === 'preparation' ? preparationText(p.preparation) : p.text],
      ]);
    });
    if (!patches.length && revised.length) {
      for (const after of revised) {
        const before = generated.find((a) => a.id === after.id);
        if (!before) continue;
        const changed = [
          'description',
          'knownFacts',
          'designNotes',
          'sourceText',
          'imageRequirements',
        ] as const;
        const values = changed
          .filter((k) => before[k] !== after[k])
          .flatMap(
            (k) =>
              [
                [`${ASSET_FIELD_LABELS[k]} · 修改前`, before[k]],
                [`${ASSET_FIELD_LABELS[k]} · 修改后`, after[k]],
              ] as [string, unknown][],
          );
        if (values.length) changes.push(section(after.name, values));
      }
    }
    const remaining = rows(recheck.findings)
      .map((f) =>
        section(objectName(f.assetId), [
          ['复核发现的问题', f.issue],
          ['依据', f.basis],
        ]),
      )
      .concat(
        strings(recheck.issues).map((issue) => section('复核仍需处理', [['具体问题', issue]])),
      );
    return result(
      '具体修改了什么，复核结果如何',
      text(recheck.summary) ||
        (step.status === 'SUCCEEDED' && !patches.length
          ? '本次没有必须修正的问题，保留已整理的内容。'
          : '只修改审校指出的相关字段，其他定义与人工内容保持原样。'),
      [...changes, ...remaining],
      step.status === 'SUCCEEDED' ? undefined : step.content || waiting,
    );
  }
  if (step.id === 'SAVE') {
    return result(
      '已整理好的资产将如何使用',
      step.status === 'SUCCEEDED'
        ? '结果已保存为可编辑草稿。核对并保存修改后，可在视频制作中为镜头选用这些资产。'
        : '审校完成后保存资产草稿，已有图片和人工修改继续保留。',
      final.map((a) =>
        section(a.name, [
          ['对象类型', kindNames[a.kind]],
          ['形象摘要', a.description],
          ['在故事中的作用', a.preparation?.usage],
          [
            '后续图片需求',
            a.imageRequirements ||
              a.preparation?.images.map((i) => `${i.name}：${i.purpose}`).join('\n'),
          ],
        ]),
      ),
      waiting,
    );
  }
  return undefined;
}
