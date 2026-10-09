import { describe, expect, it, vi } from 'vitest';
import { emptyCustomizedBrief, type CustomizedBriefCandidate } from '@ai-marketing/contracts';
import type { ProjectService } from '../../../platform/project/project.service';
import type { EffectReadCacheService } from '../../../platform/cache/effect-read-cache.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import { CustomizedExtractionRepository } from './customized-extraction.repository';
import { CustomizedExtractionService } from './customized-extraction.service';

const setup = () => {
  const repository = {
    completionAccess: vi
      .fn()
      .mockResolvedValue({ inputSnapshot: { documents: [{ assetId: 'doc', assetVersion: 2 }] } }),
    complete: vi.fn().mockResolvedValue({ resultId: 'result' }),
  };
  const service = new CustomizedExtractionService(
    repository as unknown as CustomizedExtractionRepository,
    {} as ProjectService,
    {} as StoragePort,
    {} as EffectReadCacheService,
  );
  const candidate: CustomizedBriefCandidate = {
    fields: {
      ...emptyCustomizedBrief(),
      productName: '青梅酱',
      sellingPoints: ['果肉质感', '清爽梅香'],
    },
    fieldSources: {
      productName: [{ assetId: 'doc', assetVersion: 2, location: '产品名称', itemIndex: null }],
      sellingPoints: [0, 1].map((itemIndex) => ({
        assetId: 'doc',
        assetVersion: 2,
        location: '卖点',
        itemIndex,
      })),
    },
    issues: [],
  };
  return { repository, service, candidate };
};
describe('customized extraction result validation', () => {
  it('accepts contract fields with pinned document provenance, without adding empty fields', async () => {
    const { service, repository, candidate } = setup();
    await service.complete('p', 't', 'attempt', candidate);
    expect(repository.complete).toHaveBeenCalledWith('p', 't', 'attempt', candidate);
  });
  it.each(['brand-image', 'another-project-document'])(
    'rejects provenance outside the frozen document input: %s',
    async (assetId) => {
      const { service, candidate } = setup();
      candidate.fieldSources.productName![0]!.assetId = assetId;
      await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('来源映射');
    },
  );
  it('requires separate evidence for every selling point', async () => {
    const { service, candidate } = setup();
    candidate.fieldSources.sellingPoints!.pop();
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('卖点来源索引');
  });
  it('rejects malformed source entries as validation errors', async () => {
    const { service, candidate } = setup();
    const broken = {
      ...candidate,
      fieldSources: { productName: [null] },
    } as unknown as CustomizedBriefCandidate;
    await expect(service.complete('p', 't', 'attempt', broken)).rejects.toThrow('来源映射');
  });
  it('rejects empty source locations and duplicate conflict identifiers', async () => {
    const { service, candidate } = setup();
    candidate.fieldSources.productName![0]!.location = '  ';
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('来源映射');
    candidate.fieldSources.productName![0]!.location = '产品名称';
    const issue = {
      id: 'same',
      field: 'productName' as const,
      message: '名称不同',
      blocking: true,
      alternatives: ['A', 'B'],
      sourceIds: ['doc'],
    };
    candidate.issues = [issue, issue];
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('差异结构');
  });
  it('rejects unknown fields and unpinned file versions', async () => {
    const { service, candidate } = setup();
    await expect(
      service.complete('p', 't', 'attempt', {
        ...candidate,
        fields: { ...candidate.fields, creativeDirection: 'story' },
      } as unknown as CustomizedBriefCandidate),
    ).rejects.toThrow('结构无效');
    candidate.fieldSources.productName![0]!.assetVersion = 1;
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('来源映射');
  });
});
