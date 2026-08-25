import type { EffectExtractionNodeExecution } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  presentExtractionNodeDetail,
  type ExtractionNodeDetailRecord,
} from './effect-extraction-node-detail';

const snapshot = {
  schemaVersion: 1 as const,
  projectId: 'project-a',
  draftId: 'draft-a',
  mode: 'SINGLE' as const,
  sourceRevision: 7,
  globalVideoConfig: {
    aspectRatio: '1:1',
    durationSeconds: 20,
    resolution: '720P',
    frameRate: 25,
    subtitleStrategy: '无字幕',
    voiceoverStrategy: '无口播',
    bgmStrategy: '轻快',
    styleTone: '烟火食欲感',
    deliveryChannel: '视频号',
    disabledElements: ['未成年人', '医疗功效'],
  },
  product: {
    id: 'product-a',
    name: '山泉气泡水',
    category: '饮料',
    sku: 'WATER-01',
    commerceUrl: 'https://shop.example.com/private/product?id=42',
    effectiveConfig: {
      aspectRatio: '9:16' as const,
      durationSeconds: 15,
      resolution: '1080P' as const,
      frameRate: 30,
      subtitleStrategy: '跟随口播',
      voiceoverStrategy: 'AI 女声',
      bgmStrategy: '自动匹配',
      styleTone: '清爽明亮',
      deliveryChannel: '抖音',
      disabledElements: ['医疗功效'],
    },
  },
  materials: [
    {
      id: 'material-a',
      type: 'PRODUCT_DOCUMENT',
      originalFileName: 'C:\\private\\产品规格.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 2048,
      storageKey: 'private/documents/secret.docx',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
    {
      id: 'material-image',
      type: 'PRODUCT_IMAGE',
      originalFileName: 'C:\\private\\商品主图.png',
      mimeType: 'image/png',
      sizeBytes: 1048576,
      storageKey: 'private/images/secret.png',
      updatedAt: '2026-08-24T00:00:00.000Z',
    },
  ],
  dependencySnapshot: {
    sourcePackageRevision: 2,
    effectiveVideoConfigRevision: 3,
    executionInputHash: 'private-hash',
  },
};

const execution = (
  nodeId: EffectExtractionNodeExecution['nodeId'],
): EffectExtractionNodeExecution => ({
  nodeId,
  status: 'SUCCEEDED',
  warnings: [],
  errorMessage: null,
});

describe('presentExtractionNodeDetail', () => {
  it('presents document candidates and safe technical metadata without internal payloads', () => {
    const record: ExtractionNodeDetailRecord = {
      inputSnapshot: snapshot,
      updatedAt: new Date('2026-08-24T00:01:00.000Z'),
      branches: [
        {
          branch: 'DOCUMENT',
          status: 'SUCCEEDED',
          updatedAt: new Date('2026-08-24T00:01:00.000Z'),
          structuredOutput: {
            candidate: null,
            items: [
              {
                sourceId: 'material-a',
                status: 'SUCCEEDED',
                candidate: { productName: '山泉气泡水', coreSellingPoints: ['无糖'] },
                artifactStorageKey: 'private/docling/result.md',
                metadata: {
                  markdownChars: 1234,
                  modelInputChars: 1000,
                  modelInputTruncated: false,
                  prompt: 'must-not-leak',
                  rawMarkdown: '# must-not-leak',
                  aiCall: {
                    stage: 'DOCUMENT',
                    model: 'private-model-endpoint',
                    inputTokens: 100,
                    outputTokens: 20,
                  },
                },
              },
            ],
            metadata: { prompt: 'must-not-leak' },
          },
        },
      ],
      result: null,
    };

    const detail = presentExtractionNodeDetail(record, 'DOCUMENT', {
      ...execution('DOCUMENT'),
      warnings: [
        {
          code: 'SOURCE_WARNING',
          message: '详情见 https://internal.example.com/raw',
          branch: 'DOCUMENT',
          sourceId: 'material-a',
        },
      ],
    });
    const serialized = JSON.stringify(detail);

    expect(detail.sources[0]).toMatchObject({
      name: '产品规格.docx',
      status: 'SUCCEEDED',
    });
    expect(detail.sources[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'productName', value: '山泉气泡水' }),
      ]),
    );
    expect(detail.sources[0]?.fields).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'markdownChars' })]),
    );
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('private/docling');
    expect(serialized).not.toContain('private/documents');
    expect(serialized).not.toContain('material-a');
    expect(serialized).not.toContain('internal.example.com');
    expect(serialized).not.toContain('sourceId');
    expect(serialized).not.toContain('private-model-endpoint');
    expect(serialized).not.toContain('inputTokens');
  });

  it('keeps a failed document timeout only in the node error message', () => {
    const detail = presentExtractionNodeDetail(
      {
        inputSnapshot: snapshot,
        updatedAt: new Date('2026-08-24T00:01:00.000Z'),
        branches: [
          {
            branch: 'DOCUMENT',
            status: 'FAILED',
            updatedAt: new Date('2026-08-24T00:01:00.000Z'),
            structuredOutput: {
              items: [
                {
                  sourceId: 'material-a',
                  status: 'FAILED',
                  warning: '文档 AI 抽取超时',
                  metadata: {
                    error: { type: 'AI_TIMEOUT', attempts: 3, elapsedMs: 361250 },
                  },
                },
              ],
              metadata: {
                failures: [{ type: 'AI_TIMEOUT', attempts: 3, elapsedMs: 361250 }],
              },
            },
          },
        ],
        result: null,
      },
      'DOCUMENT',
      {
        ...execution('DOCUMENT'),
        status: 'FAILED',
        errorMessage: '文档 AI 抽取超时',
        warnings: [
          {
            code: 'SOURCE_WARNING',
            message: '文档 AI 抽取超时',
            branch: 'DOCUMENT',
            sourceId: null,
          },
        ],
      },
    );

    expect(detail.errorMessage).toBe('文档 AI 抽取超时');
    expect(detail.warnings).toEqual([]);
    expect(detail.sources[0]?.warnings).toEqual([]);
    expect(JSON.stringify(detail).match(/文档 AI 抽取超时/gu)).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain('361250');
    expect(JSON.stringify(detail)).not.toContain('AI_TIMEOUT');
  });

  it('shows material counts, file names, and the saved commerce link for the snapshot node', () => {
    const detail = presentExtractionNodeDetail(
      {
        inputSnapshot: snapshot,
        updatedAt: new Date('2026-08-24T00:01:00.000Z'),
      },
      'LOAD_AND_SNAPSHOT',
      { ...execution('LOAD_AND_SNAPSHOT'), status: 'PENDING' },
    );
    const serialized = JSON.stringify(detail);

    expect(detail.summary).toBe('本次共使用 3 项资料：1 份图片、1 份文档、1 个电商链接');
    expect(detail.fields).toEqual([]);
    expect(detail.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '产品规格.docx',
          media: expect.objectContaining({
            kind: 'DOCUMENT',
            typeLabel: '产品文档',
            previewUrl: null,
            sizeBytes: 2048,
          }),
          fields: [],
        }),
        expect.objectContaining({
          name: '商品主图.png',
          media: expect.objectContaining({
            kind: 'IMAGE',
            typeLabel: '商品图片',
            previewUrl:
              '/api/projects/project-a/workflows/effect/source-import/drafts/SINGLE/products/product-a/materials/material-image/content',
            sizeBytes: 1048576,
          }),
        }),
        expect.objectContaining({
          name: 'https://shop.example.com/private/product?id=42',
          media: {
            kind: 'LINK',
            typeLabel: '电商链接',
            previewUrl: null,
            sizeBytes: null,
          },
          fields: [],
        }),
      ]),
    );
    expect(serialized).not.toContain('WATER-01');
    expect(serialized).not.toContain('durationSeconds');
    expect(serialized).not.toContain('sourceRevision');
    expect(serialized).not.toContain('mimeType');
  });

  it('shows every image as an individual visual result card', () => {
    const detail = presentExtractionNodeDetail(
      {
        inputSnapshot: snapshot,
        updatedAt: new Date('2026-08-24T00:01:00.000Z'),
        branches: [
          {
            branch: 'IMAGE',
            status: 'SUCCEEDED',
            updatedAt: new Date('2026-08-24T00:01:00.000Z'),
            structuredOutput: {
              candidate: { productName: '聚合结果不展示' },
              items: [
                {
                  sourceId: 'material-image',
                  status: 'SUCCEEDED',
                  candidate: { visualFeatures: '红色瓶身', usageScenarios: '家庭聚餐' },
                },
              ],
            },
          },
        ],
      },
      'IMAGE',
      execution('IMAGE'),
    );

    expect(detail.fields).toEqual([]);
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]).toMatchObject({
      name: '商品主图.png',
      media: {
        kind: 'IMAGE',
        typeLabel: '商品图片',
        previewUrl:
          '/api/projects/project-a/workflows/effect/source-import/drafts/SINGLE/products/product-a/materials/material-image/content',
        sizeBytes: 1048576,
      },
    });
    expect(detail.sources[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'visualFeatures', value: '红色瓶身' }),
      ]),
    );
    expect(JSON.stringify(detail)).not.toContain('聚合结果不展示');
  });

  it('shows only the five global video fields from the import node', () => {
    const detail = presentExtractionNodeDetail(
      {
        inputSnapshot: snapshot,
        updatedAt: new Date('2026-08-24T00:01:00.000Z'),
        branches: [
          {
            branch: 'FORM',
            status: 'SUCCEEDED',
            structuredOutput: {
              candidate: { productName: '不应展示', productCategory: '不应展示' },
            },
            updatedAt: new Date('2026-08-24T00:01:00.000Z'),
          },
        ],
      },
      'FORM',
      execution('FORM'),
    );

    expect(detail.summary).toBe('已读取导入节点的全局视频配置');
    expect(detail.fields.map(({ label }) => label)).toEqual([
      '视频时长',
      '画幅比例',
      '风格基调',
      '投放渠道',
      '禁用元素',
    ]);
    expect(detail.fields.map(({ value }) => value)).toEqual([
      '20 秒',
      '1:1',
      '烟火食欲感',
      '视频号',
      ['未成年人', '医疗功效'],
    ]);
    expect(JSON.stringify(detail)).not.toContain('不应展示');
    expect(JSON.stringify(detail)).not.toContain('分辨率');
    expect(JSON.stringify(detail)).not.toContain('帧率');
  });

  it('projects only user-facing commerce fields and never leaks crawler internals', () => {
    const detail = presentExtractionNodeDetail(
      {
        inputSnapshot: snapshot,
        updatedAt: new Date('2026-08-24T00:01:00.000Z'),
        branches: [
          {
            branch: 'COMMERCE',
            status: 'SUCCEEDED',
            structuredOutput: {
              candidate: {
                productName: '山泉气泡水旗舰装',
                productCategory: '气泡饮料',
                priceRange: '39～49 元',
                coreSpecification: '330ml × 12 罐',
                coreSellingPoints: ['0 糖', '清爽气泡'],
                targetAudience: '不应在此节点展示',
              },
              metadata: {
                sourceHost: 'SHOP.EXAMPLE.COM',
                pageUrl: 'https://shop.example.com/private/product?token=secret',
                httpStatus: 200,
                fetchMode: 'browser',
                elapsedMs: 1234,
                tokenUsage: 987,
                model: 'private-model',
                storageKey: 'private/commerce.md',
                rawHtml: '<html>private-page-body</html>',
              },
            },
            updatedAt: new Date('2026-08-24T00:01:00.000Z'),
          },
        ],
      },
      'COMMERCE',
      execution('COMMERCE'),
    );

    expect(detail.fields).toEqual([
      { key: 'commerceHost', label: '来源网站', value: 'shop.example.com', source: null },
      { key: 'productName', label: '商品名称', value: '山泉气泡水旗舰装', source: null },
      { key: 'productCategory', label: '品类', value: '气泡饮料', source: null },
      { key: 'priceRange', label: '价格区间', value: '39～49 元', source: null },
      { key: 'coreSpecification', label: '核心规格', value: '330ml × 12 罐', source: null },
      { key: 'coreSellingPoints', label: '卖点', value: ['0 糖', '清爽气泡'], source: null },
    ]);
    const serialized = JSON.stringify(detail);
    for (const secret of [
      '/private/product',
      'token=secret',
      'httpStatus',
      'fetchMode',
      'elapsedMs',
      'tokenUsage',
      'private-model',
      'private/commerce.md',
      'private-page-body',
      '不应在此节点展示',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('keeps a safe host-only projection for historical skipped commerce output', () => {
    const detail = presentExtractionNodeDetail(
      {
        inputSnapshot: snapshot,
        updatedAt: new Date('2026-08-24T00:01:00.000Z'),
        branches: [
          {
            branch: 'COMMERCE',
            status: 'SKIPPED',
            structuredOutput: { metadata: { hasCommerceUrl: true } },
            updatedAt: new Date('2026-08-24T00:01:00.000Z'),
          },
        ],
      },
      'COMMERCE',
      {
        ...execution('COMMERCE'),
        status: 'SKIPPED',
        warnings: [
          {
            code: 'SOURCE_WARNING',
            message: '未提供电商链接，无需解析',
            branch: 'COMMERCE',
            sourceId: null,
          },
        ],
      },
    );

    expect(detail.fields).toEqual([
      { key: 'commerceHost', label: '来源网站', value: 'shop.example.com', source: null },
    ]);
    expect(detail.warnings).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain('/private/product');
  });

  it('presents a failed commerce branch as a non-blocking source failure', () => {
    const detail = presentExtractionNodeDetail(
      {
        inputSnapshot: snapshot,
        updatedAt: new Date('2026-08-24T00:01:00.000Z'),
        branches: [
          {
            branch: 'COMMERCE',
            status: 'FAILED',
            structuredOutput: {
              metadata: { sourceHost: 'shop.example.com', httpStatus: 403 },
            },
            updatedAt: new Date('2026-08-24T00:01:00.000Z'),
          },
        ],
      },
      'COMMERCE',
      { ...execution('COMMERCE'), status: 'FAILED' },
    );

    expect(detail.summary).toBe('商品页面暂时无法读取，已继续使用其他资料');
    expect(detail.fields).toEqual([
      { key: 'commerceHost', label: '来源网站', value: 'shop.example.com', source: null },
    ]);
    expect(JSON.stringify(detail)).not.toContain('403');
  });

  it('maps fusion provenance and normalized result fields to display labels', () => {
    const record: ExtractionNodeDetailRecord = {
      inputSnapshot: snapshot,
      updatedAt: new Date('2026-08-24T00:03:00.000Z'),
      branches: [
        {
          branch: 'FUSION',
          status: 'SUCCEEDED',
          updatedAt: new Date('2026-08-24T00:02:00.000Z'),
          structuredOutput: {
            candidate: { productName: '山泉气泡水', coreSellingPoints: ['无糖', '清爽'] },
            metadata: { provenance: { productName: 'FORM', coreSellingPoints: 'DOCUMENT>IMAGE' } },
          },
        },
      ],
      result: {
        draftResult: { productName: '山泉气泡水', coreSellingPoints: ['无糖', '清爽'] },
        provenance: { productName: 'FORM', coreSellingPoints: 'DOCUMENT>IMAGE' },
        conflictReport: [],
        revision: 2,
        savedAt: new Date('2026-08-24T00:03:00.000Z'),
        updatedAt: new Date('2026-08-24T00:03:00.000Z'),
      },
    };

    const fusion = presentExtractionNodeDetail(record, 'FUSION', execution('FUSION'));
    const normalized = presentExtractionNodeDetail(
      record,
      'NORMALIZATION',
      execution('NORMALIZATION'),
    );

    expect(fusion.fields.find(({ key }) => key === 'productName')?.source).toBe('人工表单');
    expect(normalized.fields.find(({ key }) => key === 'coreSellingPoints')?.source).toBe(
      '文档解析 → 图片识别',
    );
    expect(normalized.fields.find(({ key }) => key === 'revision')?.value).toBe(2);
  });
});
