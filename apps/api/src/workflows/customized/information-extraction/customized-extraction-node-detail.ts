import {
  CUSTOMIZED_BRIEF_LABELS,
  CUSTOMIZED_EXTRACTION_NODES,
  CUSTOMIZED_SEMANTIC_ACTIVITY_LABELS,
  CUSTOMIZED_IMAGE_USAGE_LABELS,
  isCustomizedBrief,
  type CustomizedBriefCandidate,
  type ExtractionDetailField,
  type ExtractionNodeDetail,
  type ExtractionStepExecution,
} from '@ai-marketing/contracts';
import type { ExtractionInput } from './customized-extraction.repository';

type Step = {
  nodeId: string;
  sourceId: string;
  status: string;
  output: unknown;
  updatedAt?: Date;
};
export type ParsedDocumentPreview = { text: string; sizeBytes: number } | null;
type DetailRecord = {
  inputSnapshot: unknown;
  steps: Step[];
  updatedAt: Date;
};
type FieldKey = keyof typeof CUSTOMIZED_BRIEF_LABELS;
const keys = Object.keys(CUSTOMIZED_BRIEF_LABELS) as FieldKey[];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Only public business text reaches the shared detail renderer.
const text = (value: unknown, limit = 4000): string =>
  typeof value === 'string'
    ? value
        .replace(/data:[^\s]+/gi, '[图片内容已省略]')
        .replace(/https?:\/\/[^\s)\]<>|]+/gi, '[链接已省略]')
        .replace(/[A-Za-z]:[\\/][^\s|]+/g, '[文件路径已省略]')
        .replace(
          /\b(?:Bearer\s+\S+|(?:token|api[_-]?key|secret|password)\s*[:=]\s*\S+)/gi,
          '[凭据已省略]',
        )
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim()
        .slice(0, limit)
    : '';
const name = (value: string) => text(value.split(/[\\/]/).pop(), 255) || '简报文档';
const field = (
  key: string,
  label: string,
  value: ExtractionDetailField['value'],
  source: string | null = null,
): ExtractionDetailField => ({ key, label, value, source });
const candidate = (output: unknown): CustomizedBriefCandidate | null => {
  const value = record(output);
  if (!isCustomizedBrief(value.fields)) return null;
  return {
    fields: value.fields,
    fieldSources: record(value.fieldSources) as CustomizedBriefCandidate['fieldSources'],
    issues: Array.isArray(value.issues)
      ? value.issues.filter(
          (issue) => issue && typeof issue === 'object' && typeof issue.message === 'string',
        )
      : [],
  };
};

/** A bounded readable excerpt, not a model summary or extracted product facts. */
export const parsedDocumentExcerpt = (raw: string): string => {
  const plain = raw
    .replace(/<!--[^]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/[*`]/g, '')
        .trim(),
    )
    .filter((line) => line && !/^\|?[\s:|+-]+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').replace(/\s*\|\s*/g, ' ｜ '))
    .join('\n');
  const safe = text(plain, 1801);
  return safe.length > 1800 ? `${safe.slice(0, 1800)}\n…（仅展示正文节选）` : safe;
};

export function presentCustomizedNodeDetail(
  task: DetailRecord,
  execution: ExtractionStepExecution,
  previews: ReadonlyMap<string, ParsedDocumentPreview> = new Map(),
): ExtractionNodeDetail {
  const input = task.inputSnapshot as ExtractionInput;
  const nodeId = execution.nodeId;
  const aggregate = task.steps.find((s) => s.nodeId === nodeId && !s.sourceId);
  const result = aggregate?.status === 'SUCCEEDED' ? candidate(aggregate.output) : null;
  const detail: ExtractionNodeDetail = {
    ...execution,
    errorMessage: text(execution.errorMessage) || null,
    warnings: [],
    summary: CUSTOMIZED_EXTRACTION_NODES.find((n) => n.id === nodeId)?.description ?? '',
    fields: [],
    sources: [],
    updatedAt: (aggregate?.updatedAt ?? task.updatedAt).toISOString(),
  };
  const sourceText = (c: CustomizedBriefCandidate, key: FieldKey, index?: number) => {
    const entries = c.fieldSources[key];
    if (!Array.isArray(entries)) return null;
    const labels = entries.flatMap((source) => {
      if (!source || (index !== undefined && source.itemIndex !== index)) return [];
      const doc = input.documents.find(
        (d) => d.assetId === source.assetId && d.assetVersion === source.assetVersion,
      );
      const location = text(source.location, 300).replace(/^#{1,6}\s+/, '');
      return doc
        ? [`${name(doc.name)} · 版本 ${doc.assetVersion}${location ? ` · ${location}` : ''}`]
        : [];
    });
    return [...new Set(labels)].join('；') || null;
  };
  const resultFields = (c: CustomizedBriefCandidate, includeEmpty = false) =>
    keys.flatMap((key) => {
      const value = c.fields[key];
      if (Array.isArray(value)) {
        return value.length
          ? value.map((item, index) =>
              field(
                `sellingPoint-${index}`,
                `核心卖点 ${index + 1}`,
                text(item),
                sourceText(c, key, index),
              ),
            )
          : includeEmpty
            ? [field(key, CUSTOMIZED_BRIEF_LABELS[key], '资料未提供')]
            : [];
      }
      return value.trim() || includeEmpty
        ? [
            field(
              key,
              CUSTOMIZED_BRIEF_LABELS[key],
              text(value) || '资料未提供',
              sourceText(c, key),
            ),
          ]
        : [];
    });
  const issueSources = (c: CustomizedBriefCandidate): ExtractionNodeDetail['sources'] =>
    c.issues.flatMap((raw, index) => {
      const issue = record(raw);
      if (!keys.includes(issue.field as FieldKey) || typeof issue.message !== 'string') return [];
      const sourceIds = issue.sourceIds;
      const sources = Array.isArray(sourceIds)
        ? input.documents
            .filter((d) => sourceIds.includes(d.assetId))
            .map((d) => name(d.name))
            .join('、')
        : '';
      return [
        {
          name: `${issue.blocking ? '待确认' : '资料提示'} · ${CUSTOMIZED_BRIEF_LABELS[issue.field as FieldKey]}`,
          status: 'PARTIAL' as const,
          fields: [
            field(`issue-${index}`, '发现的差异', text(issue.message), sources || null),
            ...(Array.isArray(issue.alternatives)
              ? issue.alternatives
                  .filter((v) => typeof v === 'string')
                  .map((v, i) => field(`alternative-${i}`, `候选内容 ${i + 1}`, text(v)))
              : []),
          ],
          warnings: [],
        },
      ];
    });
  const filledCount = (c: CustomizedBriefCandidate) =>
    keys.filter((key) =>
      Array.isArray(c.fields[key]) ? c.fields[key].length > 0 : c.fields[key].trim().length > 0,
    ).length;

  if (nodeId === 'LOAD_AND_SNAPSHOT') {
    detail.summary = '本次按已确认资料包的固定版本提炼文档，品牌图片仅保留引用供后续视觉生成使用。';
    detail.fields = [
      field('sourceRevision', '资料包版本', input.source.revision),
      field('documentCount', '参与提炼的简报文档', input.documents.length),
      field('brandCount', '保留引用的品牌素材', input.brandReferences.length),
      ...input.brandReferences.map((ref, i) =>
        field(
          `brand-${i}`,
          `品牌素材 ${i + 1}`,
          ref.imageUsage ? CUSTOMIZED_IMAGE_USAGE_LABELS[ref.imageUsage] : '品牌素材',
          `版本 ${ref.assetVersion}`,
        ),
      ),
    ];
    detail.sources = input.documents.map((doc) => ({
      name: name(doc.name),
      status: execution.status,
      media: {
        kind: 'DOCUMENT',
        typeLabel: '视频创作简报',
        previewUrl: null,
        sizeBytes: doc.sizeBytes,
      },
      fields: [field('version', '文件版本', doc.assetVersion)],
      warnings: [],
    }));
    detail.warnings = (input.sourceWarnings ?? []).map((message) => ({
      code: 'SOURCE_REFERENCE',
      message: text(message),
    }));
    return detail;
  }

  if (nodeId === 'DOCUMENT_PARSE' || nodeId === 'DOCUMENT_EXTRACT') {
    const steps = input.documents.map((doc) =>
      task.steps.find((s) => s.nodeId === nodeId && s.sourceId === doc.assetId),
    );
    detail.summary =
      nodeId === 'DOCUMENT_PARSE'
        ? '逐份读取文档正文与表格。下方为实际解析原文节选，文档中的备注和示例不代表已提取的产品事实。'
        : '按文档提取品牌与产品信息，逐条保留卖点及其来源位置；空白和未提供的信息不补造。';
    const completed = steps.filter((s) => s?.status === 'SUCCEEDED').length;
    const failed = steps.filter((s) => s?.status === 'FAILED').length;
    detail.fields = [
      field(
        'completed',
        '文档处理进度',
        `已完成 ${completed} / ${input.documents.length} 份${failed ? `，${failed} 份失败` : ''}`,
      ),
    ];
    detail.sources = input.documents.map((doc, index) => {
      const step = steps[index];
      const c = step?.status === 'SUCCEEDED' ? candidate(step.output) : null;
      const preview = previews.get(doc.assetId);
      return {
        name: name(doc.name),
        status: (step?.status ?? 'PENDING') as ExtractionNodeDetail['status'],
        media: {
          kind: 'DOCUMENT',
          typeLabel: '视频创作简报',
          previewUrl: null,
          sizeBytes: doc.sizeBytes,
        },
        fields: [
          field('version', '文件版本', doc.assetVersion),
          ...(preview
            ? [
                field('parsedSize', '解析文本大小', `${(preview.sizeBytes / 1024).toFixed(1)} KB`),
                field('excerpt', '解析正文节选', preview.text || '未读取到可展示的文字'),
              ]
            : []),
          ...(c
            ? [
                field('fieldCount', '已提取填写项', `${filledCount(c)} / ${keys.length}`),
                field('sellingPointCount', '独立卖点', c.fields.sellingPoints.length),
                ...resultFields(c),
              ]
            : []),
        ],
        warnings: [
          ...(step?.status === 'FAILED'
            ? ['该文档处理未完成，请重试或检查文件；成功文档的结果已保留。']
            : []),
          ...(previews.has(doc.assetId) && !preview
            ? ['解析正文暂时无法读取，可刷新详情重试；不影响已保存的提炼结果。']
            : []),
          ...(c ? c.issues.map((issue) => text(issue.message)).filter(Boolean) : []),
        ],
      };
    });
    return detail;
  }

  if (nodeId === 'SEMANTIC_REFINEMENT') {
    const activity = record(record(aggregate?.output).activity);
    const activitySteps =
      activity.schemaVersion === 1 && Array.isArray(activity.steps)
        ? activity.steps.map(record)
        : [];
    const unitLabels = { DOCUMENT: '份文档', CHUNK: '个片段', ISSUE: '条差异' } as const;
    const processingDescriptions: Record<string, string> = {
      RAW_AUDIT: '逐份对照原文检查全部填写项，核对遗漏、错误归属和实质矛盾。',
      EVIDENCE_RECHECK: '重读所有文档中相关字段的原文依据，核对互补信息与适用条件。',
      TARGETED_REPAIR: '结合审校建议与原文依据修正相关信息，保留未涉及的事实和卖点。',
      FINAL_REVIEW: '核对修正后的事实、品牌约束及每条已有差异，等待模型返回核对结果。',
      CONFLICT_EVIDENCE: '为最终核对中新发现的差异字段补充原文依据。',
      CONFLICT_COMPLETION: '逐条整理差异的完整候选内容，保留各候选共有的事实。',
    };
    const skipReasons: Record<string, string> = {
      EVIDENCE_RECHECK: '没有需要复核的审校建议或既有资料差异。',
      TARGETED_REPAIR: '原文审校未提出需修正的问题。',
      FINAL_REVIEW: '资料未提供可核对的填写内容。',
      CONFLICT_EVIDENCE: '最终核对未新增需要补充依据的差异字段。',
      CONFLICT_COMPLETION: '没有待整理的资料差异。',
    };
    const countText = (raw: Record<string, unknown>) => {
      const unit = unitLabels[raw.unit as keyof typeof unitLabels];
      return unit &&
        Number.isSafeInteger(raw.completed) &&
        Number.isSafeInteger(raw.total) &&
        (raw.completed as number) >= 0 &&
        (raw.total as number) > 0 &&
        (raw.completed as number) <= (raw.total as number)
        ? `已完成 ${raw.completed} / ${raw.total} ${unit}`
        : null;
    };
    const processSources = Object.entries(CUSTOMIZED_SEMANTIC_ACTIVITY_LABELS).flatMap(
      ([id, label]) => {
        const current = activitySteps.find((s) => s.id === id);
        if (
          !current ||
          !['PENDING', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED'].includes(String(current.status))
        )
          return [];
        const count = countText(current);
        return [
          {
            name: label,
            status: current.status as ExtractionNodeDetail['status'],
            fields: [
              field(
                'activity',
                '处理情况',
                count ??
                  (
                    {
                      PENDING: '等待前序处理完成',
                      RUNNING: '正在处理，请稍候',
                      SUCCEEDED: '处理完成',
                      SKIPPED: '本次无需执行',
                      FAILED: '处理未完成，已完成记录保留',
                    } as Record<string, string>
                  )[String(current.status)]!,
              ),
              ...(current.status === 'RUNNING'
                ? [field('processing', '处理内容', processingDescriptions[id]!)]
                : current.status === 'SKIPPED' && skipReasons[id]
                  ? [field('reason', '无需执行的原因', skipReasons[id]!)]
                  : []),
            ],
            warnings: [],
          },
        ];
      },
    );
    const active = processSources.find((s) => s.status === 'RUNNING');
    if (active) detail.fields.push(field('currentWork', '当前处理', active.name));
    if (processSources.length) detail.sources.push(...processSources);
    const audits = input.documents.flatMap((doc) => {
      const s = task.steps.find((s) => s.nodeId === nodeId && s.sourceId === doc.assetId);
      if (!s && execution.status === 'SUCCEEDED') return [];
      const status = s?.status ?? 'PENDING';
      if (!['PENDING', 'SUCCEEDED', 'FAILED', 'RUNNING', 'SKIPPED'].includes(status)) return [];
      const output = record(s?.output);
      const report = status === 'SUCCEEDED' ? record(output.auditReport) : {};
      const auditProgress = countText({ ...record(output.auditProgress), unit: 'CHUNK' });
      const checked = Array.isArray(report.checkedFields)
        ? keys.filter((key) => (report.checkedFields as unknown[]).includes(key))
        : [];
      const findings = Array.isArray(report.findings) ? report.findings : [];
      return [
        {
          name: `${name(doc.name)} · 原文审校`,
          status: status as ExtractionNodeDetail['status'],
          fields: [
            field('version', '文件版本', doc.assetVersion),
            ...(auditProgress ? [field('auditProgress', '原文片段审校', auditProgress)] : []),
            ...(checked.length
              ? [
                  field(
                    'checked',
                    '已核对填写项',
                    checked.map((key) => CUSTOMIZED_BRIEF_LABELS[key]),
                  ),
                ]
              : []),
            ...(typeof output.chunkCount === 'number'
              ? [field('chunks', '已审校文档片段', output.chunkCount)]
              : []),
            ...findings.flatMap((raw, i) => {
              const finding = record(raw);
              const evidence = record(finding.evidence);
              if (
                !keys.includes(finding.field as FieldKey) ||
                evidence.assetId !== doc.assetId ||
                evidence.assetVersion !== doc.assetVersion
              )
                return [];
              const source = `${name(doc.name)} · 版本 ${doc.assetVersion} · ${text(evidence.location, 300)}`;
              return [
                field(
                  `finding-${i}`,
                  CUSTOMIZED_BRIEF_LABELS[finding.field as FieldKey],
                  text(finding.description),
                  source,
                ),
                field(`quote-${i}`, '原文依据', text(evidence.quote, 2000), source),
                field(`proposal-${i}`, '审校建议', text(finding.proposedValue)),
              ];
            }),
            ...(status === 'SUCCEEDED' && checked.length && !findings.length
              ? [field('findings', '审校结果', '未发现需修正的问题')]
              : []),
            ...(status === 'SKIPPED'
              ? [field('skipped', '审校结果', '空白模板不包含填写内容，已跳过')]
              : []),
          ],
          warnings:
            status === 'FAILED'
              ? ['原文审校未完成，不能将本次提炼确认为版本；成功文档的审校记录已保留。']
              : [],
        },
      ];
    });
    detail.sources.push(...audits);
    if (!result) {
      detail.summary = active
        ? `正在${active.name}，下方处理状态随后台执行自动更新。`
        : execution.status === 'RUNNING'
          ? '正在核对文档事实与品牌约束，文档审校记录随后台执行自动更新。'
          : execution.status === 'PENDING'
            ? '等待前序步骤完成，尚未开始语义精炼。'
            : '语义精炼未完整完成，以下保留实际处理进展和成功的审校记录。';
      return detail;
    }
    const summary = record(record(aggregate?.output).auditSummary);
    if (aggregate?.status === 'SUCCEEDED' && summary.schemaVersion === 1) {
      for (const [key, label] of [
        ['documentCount', '原文审校文档'],
        ['chunkCount', '原文审校片段'],
        ['findingCount', '审校建议'],
      ] as const) {
        if (typeof summary[key] === 'number') detail.fields.push(field(key, label, summary[key]));
      }
      if (Array.isArray(summary.correctedFields))
        detail.fields.push(
          field(
            'corrected',
            '实际修正的填写项',
            summary.correctedFields.length
              ? keys
                  .filter((key) => (summary.correctedFields as unknown[]).includes(key))
                  .map((key) => CUSTOMIZED_BRIEF_LABELS[key])
              : '未改动填写内容',
          ),
        );
    }
  }
  if (!result) {
    detail.summary =
      execution.status === 'PENDING'
        ? '等待前序步骤完成，尚无本阶段结果。'
        : execution.status === 'RUNNING'
          ? '正在处理，完成后可查看本阶段结果。'
          : '本阶段尚未完整完成，已成功的文档结果可在文档信息提取中查看。';
    return detail;
  }
  detail.summary =
    nodeId === 'FUSION'
      ? `已汇总 ${input.documents.length} 份文档，以下为融合后的信息及对应来源。`
      : nodeId === 'SEMANTIC_REFINEMENT'
        ? '以下为语义核对后保留的信息、文档依据与仍需确认的差异。未提供内容保持空缺。'
        : '已生成可编辑的信息卡草稿。AI 完成不代表版本确认，编辑并保存版本后才供分镜创作使用。';
  const missingFields = keys
    .filter((key) =>
      Array.isArray(result.fields[key]) ? !result.fields[key].length : !result.fields[key].trim(),
    )
    .map((key) => CUSTOMIZED_BRIEF_LABELS[key]);
  detail.fields.push(
    field('filledCount', '已有资料的填写项', `${filledCount(result)} / ${keys.length}`),
    field('sellingPointCount', '独立卖点', result.fields.sellingPoints.length),
    field('issues', '待确认差异', result.issues.filter((issue) => issue.blocking).length),
    ...(nodeId === 'NORMALIZATION'
      ? [
          field(
            'missing',
            '资料未提供的填写项',
            missingFields.length ? missingFields : '无，所有填写项均有资料',
          ),
          field(
            'required',
            '必要信息检查',
            result.fields.productName.trim() && result.fields.sellingPoints.some((v) => v.trim())
              ? '产品名称及至少一条有效卖点已提供'
              : '仍需补充产品名称或有效卖点',
          ),
        ]
      : []),
    ...resultFields(result, nodeId === 'NORMALIZATION'),
  );
  detail.sources.push(...issueSources(result));
  return detail;
}
