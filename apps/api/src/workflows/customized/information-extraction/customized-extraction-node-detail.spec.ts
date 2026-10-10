import { describe, expect, it } from 'vitest';
import {
  emptyCustomizedBrief,
  type CustomizedBriefCandidate,
  type ExtractionStepExecution,
} from '@ai-marketing/contracts';
import type { ExtractionInput } from './customized-extraction.repository';
import {
  parsedDocumentExcerpt,
  presentCustomizedNodeDetail,
} from './customized-extraction-node-detail';

const input: ExtractionInput = {
  source: { artifactId: 'source', revision: 3, fingerprint: 'hash' },
  documents: [
    { assetId: 'a', assetVersion: 2, name: '简报.docx', storageKey: 'private/a', sizeBytes: 4000 },
    { assetId: 'b', assetVersion: 1, name: '补充.pdf', storageKey: 'private/b', sizeBytes: 8000 },
  ],
  brandReferences: [
    { assetId: 'logo', assetVersion: 1, category: 'VISUAL_REFERENCE', imageUsage: 'LOGO' },
  ],
};
const result: CustomizedBriefCandidate = {
  fields: {
    ...emptyCustomizedBrief(),
    brandName: '梅间',
    productName: '青梅酱',
    productSpecifications: '220 g',
    sellingPoints: ['酸甜梅香', '果肉颗粒'],
  },
  fieldSources: {
    productName: [{ assetId: 'a', assetVersion: 2, location: '产品名称' }],
    sellingPoints: [
      { assetId: 'a', assetVersion: 2, location: '核心卖点', itemIndex: 0 },
      { assetId: 'b', assetVersion: 1, location: '第2页', itemIndex: 1 },
    ],
  },
  issues: [
    {
      id: 'spec',
      field: 'productSpecifications',
      message: '两份资料的净含量不同',
      sourceIds: ['a', 'b'],
      alternatives: ['220 g', '240 g'],
      blocking: true,
    },
  ],
};
const execution = (
  nodeId: string,
  status: ExtractionStepExecution['status'] = 'SUCCEEDED',
): ExtractionStepExecution => ({ nodeId, status, warnings: [], errorMessage: null });
const step = (nodeId: string, sourceId = '', output: unknown = result, status = 'SUCCEEDED') => ({
  nodeId,
  sourceId,
  output,
  status,
});
const task = (steps: ReturnType<typeof step>[]) => ({
  inputSnapshot: input,
  steps,
  updatedAt: new Date('2026-10-10T00:00:00Z'),
});

describe('customized extraction public node details', () => {
  it('shows the pinned input revision and image usage without treating images as extracted facts', () => {
    const detail = presentCustomizedNodeDetail(task([]), execution('LOAD_AND_SNAPSHOT'));
    expect(detail.fields.find((f) => f.key === 'sourceRevision')?.value).toBe(3);
    expect(detail.fields.find((f) => f.key === 'brand-0')?.value).toBe('品牌 Logo');
    expect(detail.summary).toContain('仅保留引用');
    expect(JSON.stringify(detail)).not.toContain('private/');
  });
  it('uses real parsed excerpts, preserves per-document states and does not substitute extraction results', () => {
    const detail = presentCustomizedNodeDetail(
      task([
        step('DOCUMENT_PARSE', 'a', { parsed: true }),
        step('DOCUMENT_PARSE', 'b', {}, 'FAILED'),
        step('NORMALIZATION'),
      ]),
      execution('DOCUMENT_PARSE', 'PARTIAL'),
      new Map([['a', { text: '产品名称 ｜ 青梅酱', sizeBytes: 3200 }]]),
    );
    expect(detail.sources[0]?.fields.find((f) => f.key === 'excerpt')?.value).toBe(
      '产品名称 ｜ 青梅酱',
    );
    expect(detail.sources[0]?.fields.some((f) => f.key === 'productName')).toBe(false);
    expect(detail.sources[1]?.status).toBe('FAILED');
    expect(detail.fields.find((f) => f.key === 'completed')?.value).toBe(
      '已完成 1 / 2 份，1 份失败',
    );
    expect(detail.sources[1]?.warnings).toHaveLength(1);
  });
  it('shows extracted fields and separate provenance for every selling point', () => {
    const detail = presentCustomizedNodeDetail(
      task([step('DOCUMENT_EXTRACT', 'a')]),
      execution('DOCUMENT_EXTRACT'),
    );
    expect(detail.sources[0]?.fields.find((f) => f.key === 'sellingPoint-0')?.source).toContain(
      '简报.docx · 版本 2 · 核心卖点',
    );
    expect(detail.sources[0]?.fields.find((f) => f.key === 'sellingPoint-1')?.source).toContain(
      '补充.pdf · 版本 1 · 第2页',
    );
    expect(detail.sources[1]?.status).toBe('PENDING');
  });
  it.each(['FUSION', 'SEMANTIC_REFINEMENT'])(
    'shows actual %s fields and conflict candidates',
    (node) => {
      const detail = presentCustomizedNodeDetail(task([step(node)]), execution(node));
      expect(detail.fields.find((f) => f.key === 'productName')?.value).toBe('青梅酱');
      expect(detail.sources[0]?.name).toBe('待确认 · 产品规格');
      expect(detail.sources[0]?.fields.map((f) => f.value)).toEqual([
        '两份资料的净含量不同',
        '220 g',
        '240 g',
      ]);
      expect(detail.sources[0]?.fields[0]?.source).toBe('简报.docx、补充.pdf');
    },
  );
  it('shows missing data without inventing it and explains the draft confirmation boundary', () => {
    const detail = presentCustomizedNodeDetail(
      task([step('NORMALIZATION')]),
      execution('NORMALIZATION'),
    );
    expect(detail.fields.find((f) => f.key === 'productAppearance')?.value).toBe('资料未提供');
    expect(detail.fields.find((f) => f.key === 'missing')?.value).toContain('产品外观');
    expect(detail.summary).toContain('AI 完成不代表版本确认');
  });
  it('does not show future, running or failed checkpoint outputs as successful results', () => {
    for (const status of ['PENDING', 'RUNNING', 'FAILED'] as const) {
      const detail = presentCustomizedNodeDetail(
        task([step('FUSION', '', result, status), step('NORMALIZATION')]),
        execution('FUSION', status),
      );
      expect(detail.fields).toEqual([]);
      expect(detail.sources).toEqual([]);
    }
  });
  it('does not attribute results to an unpinned version or another project file', () => {
    const c = structuredClone(result);
    c.fieldSources.productName = [
      { assetId: 'a', assetVersion: 9, location: 'wrong' },
      { assetId: 'external', assetVersion: 2, location: 'wrong' },
    ];
    const detail = presentCustomizedNodeDetail(task([step('FUSION', '', c)]), execution('FUSION'));
    expect(detail.fields.find((f) => f.key === 'productName')?.source).toBeNull();
  });
  it('shows actual raw audit evidence while running without publishing a finished result', () => {
    const detail = presentCustomizedNodeDetail(
      task([
        step('SEMANTIC_REFINEMENT', 'a', {
          auditReport: {
            checkedFields: ['productSpecifications'],
            findings: [
              {
                field: 'productSpecifications',
                description: '净含量遗漏',
                proposedValue: '220g',
                evidence: {
                  assetId: 'a',
                  assetVersion: 2,
                  location: '规格第1行',
                  quote: '净含量220g',
                },
              },
            ],
          },
          chunkCount: 2,
        }),
        step('SEMANTIC_REFINEMENT', 'b', {}, 'FAILED'),
        step('SEMANTIC_REFINEMENT', '', {}, 'PARTIAL'),
      ]),
      execution('SEMANTIC_REFINEMENT', 'PARTIAL'),
    );
    expect(detail.fields).toEqual([]);
    expect(detail.sources[0]?.fields.find((f) => f.key === 'quote-0')).toMatchObject({
      value: '净含量220g',
      source: '简报.docx · 版本 2 · 规格第1行',
    });
    expect(detail.sources[1]?.warnings[0]).toContain('不能');
    expect(detail.sources[0]?.fields.find((f) => f.key === 'chunks')?.value).toBe(2);
  });
  it('shows completed audit counts, actual corrections and remaining conflicts together', () => {
    const detail = presentCustomizedNodeDetail(
      task([
        step('SEMANTIC_REFINEMENT', '', {
          ...result,
          auditSummary: {
            schemaVersion: 1,
            documentCount: 2,
            chunkCount: 3,
            findingCount: 1,
            correctedFields: ['productSpecifications'],
          },
        }),
      ]),
      execution('SEMANTIC_REFINEMENT'),
    );
    expect(detail.fields.find((f) => f.key === 'findingCount')?.value).toBe(1);
    expect(detail.fields.find((f) => f.key === 'corrected')?.value).toEqual(['产品规格']);
    expect(detail.sources[0]?.name).toBe('待确认 · 产品规格');
  });
  it('reports an unavailable excerpt separately without rewriting the completed parse status', () => {
    const detail = presentCustomizedNodeDetail(
      task([step('DOCUMENT_PARSE', 'a', { parsed: true })]),
      execution('DOCUMENT_PARSE'),
      new Map([['a', null]]),
    );
    expect(detail.status).toBe('SUCCEEDED');
    expect(detail.sources[0]?.status).toBe('SUCCEEDED');
    expect(detail.sources[0]?.warnings[0]).toContain('正文暂时无法读取');
  });
  it('renders bounded plain text without markdown, images, URLs, local paths or credentials', () => {
    const excerpt = parsedDocumentExcerpt(
      '# 品牌信息\n| 填写项 | 填写内容 |\n| --- | --- |\n| 产品 | **青梅酱** |\n![logo](data:image/png;base64,abc)\n[网页](https://example.com/?token=secret)\nC:\\private\\file.txt Bearer abc api_key=secret\n' +
        '内容'.repeat(1500),
    );
    expect(excerpt).toContain('产品 ｜ 青梅酱');
    expect(excerpt).not.toMatch(/https:|base64|private|Bearer|api_key|\*\*|\| ---/);
    expect(excerpt.length).toBeLessThan(1850);
    expect(excerpt).toContain('仅展示正文节选');
  });
});
