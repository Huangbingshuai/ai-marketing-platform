import { expect, it } from 'vitest';
import {
  emptyCustomizedBrief,
  type ProductionAsset,
  type ProductionInput,
} from '@ai-marketing/contracts';
import { assetExecutionDetail } from './asset-execution-detail';

const input: ProductionInput = {
  operation: 'ASSETS',
  assetWorkflowVersion: 2,
  shotId: null,
  targetAssetId: null,
  draftRevision: 1,
  sources: [{ id: 'private-artifact-id', revision: 1, hash: 'private-hash' }],
  models: { creative: 'internal-model', detail: 'internal-model' },
  script: {
    id: 'script-id',
    name: '晚点广播响起之后',
    synopsis: '周越在候车区接入充电器后收纳离开。',
    structure: '',
    productFocus: '折叠插脚与多口连接',
    assets: [],
    shots: [],
  },
  brief: {
    ...emptyCustomizedBrief(),
    brandName: '弧电',
    productName: 'G65充电器',
    productAppearance: '深灰色磨砂机身',
    visualConsistencyRules: '保持端口位置一致',
    avoidedElements: '不表现虚构充电速度',
    sellingPoints: ['单USB-C最高65W'],
  },
  document: { assets: [], shots: [] },
};
const product: ProductionAsset = {
  id: 'product-private-id',
  kind: 'PRODUCT',
  name: '弧电G65',
  description: '灰色外壳',
  knownFacts: '单USB-C最高65W',
  designNotes: '插脚所在侧面待确认',
  sourceText: '',
  imageRequirements: '端口正面参考图',
  preparation: {
    aliases: ['G65'],
    usage: '展示多口连接与收纳',
    treatment: 'INDEPENDENT',
    parentId: null,
    sources: [
      {
        source: 'BRIEF',
        path: '/productAppearance',
        quote: '深灰色磨砂机身',
        field: 'description',
      },
    ],
    details: [{ key: 'structure', value: '插脚所在侧面待确认' }],
    questions: [
      { field: 'structure', question: '插脚位于机身哪一侧？', impact: '影响后续接电与折叠动作' },
    ],
    images: [
      {
        name: '端口正面图',
        purpose: '统一各镜头接口位置',
        requirements: '两个USB-C与一个USB-A端口',
      },
    ],
  },
};
const output = {
  inventory: [
    {
      id: product.id,
      name: product.name,
      kind: 'PRODUCT',
      aliases: ['G65'],
      usage: '接电后收纳',
      existingId: null,
      treatment: 'INDEPENDENT',
      parentId: null,
      sources: [{ source: 'BRIEF', path: '/productAppearance', quote: '深灰色磨砂机身' }],
    },
  ],
  batches: { 'PRODUCT:0': [product] },
  audit: {
    summary: '插脚位置缺少资料依据，需要修正。',
    findings: [
      {
        assetId: product.id,
        field: 'description',
        issue: '外壳颜色没有完整保留',
        basis: '资料明确写了深灰色磨砂机身',
        severity: 'REQUIRED',
      },
    ],
  },
  patches: {
    patches: [
      { assetId: product.id, field: 'description', text: '深灰色磨砂机身', preparation: null },
    ],
  },
  revised: [{ ...product, description: '深灰色磨砂机身' }],
  recheck: { summary: '颜色已修正，未知插脚位置仍保留待确认。', findings: [] },
  final: { assets: [{ ...product, description: '深灰色磨砂机身' }], shots: [] },
};
const detail = (id: string, status = 'SUCCEEDED', result: unknown = output) =>
  assetExecutionDetail({ id, status, title: '内部阶段标题', content: '' }, input, result)!;

it('shows actual story, product facts and constraints without internal source/configuration data', () => {
  const value = JSON.stringify(detail('SNAPSHOT'));
  expect(value).toContain('晚点广播响起之后');
  expect(value).toContain('单USB-C最高65W');
  expect(value).toContain('保持端口位置一致');
  expect(value).toContain('不表现虚构充电速度');
  for (const hidden of ['private-artifact-id', 'private-hash', 'internal-model'])
    expect(value).not.toContain(hidden);
});

it('projects all asset stages into concrete business content; category definitions stay before repair', () => {
  expect(JSON.stringify(detail('INVENTORY'))).toContain('接电后收纳');
  expect(JSON.stringify(detail('IDENTITY'))).toContain('独立准备参考形象');
  const definition = JSON.stringify(detail('PRODUCT'));
  expect(definition).toContain('灰色外壳');
  expect(definition).toContain('插脚位于机身哪一侧');
  expect(definition).not.toContain('深灰色磨砂机身');
  expect(JSON.stringify(detail('IMAGE_PLAN'))).toContain('统一各镜头接口位置');
  expect(JSON.stringify(detail('REVIEW'))).toContain('外壳颜色没有完整保留');
  const repair = JSON.stringify(detail('REPAIR'));
  expect(repair).toContain('修改前');
  expect(repair).toContain('灰色外壳');
  expect(repair).toContain('深灰色磨砂机身');
  expect(JSON.stringify(detail('SAVE'))).toContain('可编辑草稿');
  for (const id of ['INVENTORY', 'IDENTITY', 'PRODUCT', 'IMAGE_PLAN', 'REVIEW', 'REPAIR', 'SAVE']) {
    expect(JSON.stringify(detail(id))).not.toContain('product-private-id');
  }
});

it('distinguishes waiting/partial/empty results and preserves legacy review and repair evidence', () => {
  expect(detail('CHARACTER', 'PENDING', {}).emptyMessage).toContain('执行到这一步');
  expect(detail('CHARACTER').emptyMessage).toContain('无需单独准备');
  expect(detail('PRODUCT', 'FAILED', { batches: output.batches }).sections).toHaveLength(1);
  const legacy = {
    value: { assets: [product] },
    revised: [{ ...product, description: '修正后的外观' }],
    audit: { issues: ['材质未说明'], summary: '需核对材质' },
    recheck: { summary: '修正完成', issues: [] },
  };
  expect(JSON.stringify(detail('REVIEW', 'SUCCEEDED', legacy))).toContain('材质未说明');
  expect(JSON.stringify(detail('REPAIR', 'SUCCEEDED', legacy))).toContain('修正后的外观');
  expect(
    assetExecutionDetail(
      { id: 'REVIEW', status: 'SUCCEEDED', title: '', content: '' },
      { ...input, operation: 'PROMPT' },
      output,
    ),
  ).toBeUndefined();
});

it('renders model-written IDs, source paths and field names as readable business references', () => {
  const value = JSON.stringify(
    detail('REVIEW', 'SUCCEEDED', {
      ...output,
      audit: {
        summary: `${product.id}：依据BRIEF检查，asset-...-5保留questions。`,
        findings: [
          {
            assetId: product.id,
            field: 'preparation',
            severity: 'REQUIRED',
            issue: 'preparation.details.markings与knownFacts需要同步，asset-4需核对。',
            basis: 'BRIEF /productAppearance与SCRIPT /story/beats/1、SCRIPT /story/content。',
          },
        ],
      },
    }),
  );
  expect(value).toContain('弧电G65');
  expect(value).toContain('信息卡「产品外观」');
  expect(value).toContain('脚本「叙事段落 2」');
  expect(value).toContain('脚本「故事正文」');
  for (const hidden of [
    product.id,
    'BRIEF',
    'SCRIPT',
    '/productAppearance',
    'preparation.details',
    'knownFacts',
    'asset-4',
    'asset-...-5',
    'questions',
  ])
    expect(value).not.toContain(hidden);
  expect(output.audit.summary).toBe('插脚位置缺少资料依据，需要修正。');
});

it('explains automatically confirmed catalogs without asking for another confirmation', () => {
  const saved = JSON.stringify(
    detail('SAVE', 'SUCCEEDED', { ...output, publishedWorkflowRunId: 'private-run-id' }),
  );
  expect(saved).toContain('资产目录已确认并保存');
  expect(saved).not.toContain('可编辑草稿');
  expect(saved).not.toContain('private-run-id');
});
