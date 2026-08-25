import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getEffectExtractionNodeDetail,
  getEffectExtractionRun,
  getEffectExtractionWorkspace,
  startEffectExtractionRun,
  updateEffectExtractionResult,
} from './effect-info-extraction.api';

afterEach(() => vi.unstubAllGlobals());

const ok = (): Response =>
  new Response(JSON.stringify({ success: true, data: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('effect info extraction API', () => {
  it('uses one API prefix and encodes all path identifiers', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    await getEffectExtractionWorkspace('项目/1', '草稿/1');
    await getEffectExtractionRun('项目/1', 'run/1');
    await getEffectExtractionNodeDetail('项目/1', 'run/1', 'DOCUMENT');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/projects/%E9%A1%B9%E7%9B%AE%2F1/workflows/effect/information-extraction?draftId=%E8%8D%89%E7%A8%BF%2F1',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/runs/run%2F1');
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/runs/run%2F1/nodes/DOCUMENT');
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('/api/api/');
  });

  it('starts only the selected product and forwards source revision and idempotency key', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    await startEffectExtractionRun('project-1', 'product/1', {
      draftId: 'draft-1',
      expectedRevision: 7,
      idempotencyKey: 'extract-once-1',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/products/product%2F1/runs');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('If-Match')).toBe('7');
    expect(JSON.parse(String(init.body))).toEqual({
      draftId: 'draft-1',
      expectedRevision: 7,
      idempotencyKey: 'extract-once-1',
    });
  });

  it('saves an edited result with optimistic revision control', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const result = {
      productCategory: '食品',
      productName: '测试产品',
      coreSpecification: '500g',
      priceRange: '50-80元',
      visualFeatures: '红色包装',
      targetAudience: '家庭用户',
      marketingGoal: '提升转化',
      coreSellingPoints: ['方便'],
      usageScenarios: '家庭聚餐',
      deliveryChannels: '抖音',
      brandTone: '真实',
      disabledElements: ['绝对化用语'],
    };

    await updateEffectExtractionResult('project-1', 'result/1', {
      expectedRevision: 3,
      result,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/results/result%2F1');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('If-Match')).toBe('3');
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 3, result });
  });
});
