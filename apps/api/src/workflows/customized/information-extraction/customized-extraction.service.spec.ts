import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { emptyCustomizedBrief, type CustomizedBriefCandidate } from '@ai-marketing/contracts';
import type { ProjectService } from '../../../platform/project/project.service';
import type { EffectReadCacheService } from '../../../platform/cache/effect-read-cache.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { CustomizedExtractionRepository } from './customized-extraction.repository';
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
  it('accepts exact scoped candidates and rejects an unrelated base or inconsistent patch', async () => {
    const { service, repository, candidate } = setup();
    const before = '青梅酱';
    candidate.issues = [
      {
        id: 'name',
        field: 'productName',
        message: '产品名记录冲突',
        blocking: true,
        sourceIds: ['doc'],
        alternatives: ['青梅酱', '青梅果酱'],
        resolution: {
          schemaVersion: 1,
          baseValue: before,
          before,
          replacements: ['青梅酱', '青梅果酱'],
        },
      },
    ];
    await service.complete('p', 't', 'attempt', candidate);
    expect(repository.complete).toHaveBeenCalledOnce();
    candidate.issues[0]!.resolution!.baseValue = '另一字段';
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('局部候选');
    candidate.issues[0]!.resolution!.baseValue = before;
    candidate.issues[0]!.alternatives = [];
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('局部候选');
    candidate.issues[0]!.alternatives = ['无关整段', '青梅果酱'];
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('局部候选');
  });
  it('rejects overlapping patch scopes even if each replacement is individually valid', async () => {
    const { service, candidate } = setup();
    const issue = {
      id: 'name',
      field: 'productName' as const,
      message: '记录冲突',
      blocking: true,
      sourceIds: ['doc'],
      alternatives: ['青梅酱', '青梅果酱'],
      resolution: {
        schemaVersion: 1 as const,
        baseValue: '青梅酱',
        before: '青梅酱',
        replacements: ['青梅酱', '青梅果酱'],
      },
    };
    candidate.issues = [issue, { ...issue, id: 'another' }];
    await expect(service.complete('p', 't', 'attempt', candidate)).rejects.toThrow('范围重叠');
  });
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

describe('customized extraction detail reads', () => {
  const detailSetup = () => {
    const projects = { get: vi.fn().mockResolvedValue({ id: 'p' }) };
    const repository = {
      task: vi.fn().mockResolvedValue({
        id: 't',
        projectId: 'p',
        workflowRunId: 'r',
        status: 'COMPLETED',
        progress: 100,
        currentNode: 'NORMALIZATION',
        errorMessage: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        inputSnapshot: {
          source: { revision: 1 },
          documents: [{ assetId: 'doc', assetVersion: 2, name: '简报.docx', sizeBytes: 4000 }],
          brandReferences: [],
        },
        steps: [
          {
            nodeId: 'DOCUMENT_PARSE',
            sourceId: 'doc',
            status: 'SUCCEEDED',
            errorMessage: null,
            output: { parsed: true },
          },
          {
            nodeId: 'DOCUMENT_PARSE',
            sourceId: '',
            status: 'SUCCEEDED',
            errorMessage: null,
            output: { processed: 1 },
          },
        ],
      }),
      findArtifact: vi.fn().mockResolvedValue({ storageKey: 'frozen/parsed', sizeBytes: 100000 }),
    };
    const storage = {
      open: vi
        .fn()
        .mockImplementation(async () => ({ stream: Readable.from(['# 产品名称\n青梅酱']) })),
    };
    const service = new CustomizedExtractionService(
      repository as unknown as CustomizedExtractionRepository,
      projects as unknown as ProjectService,
      storage as unknown as StoragePort,
      {} as EffectReadCacheService,
    );
    return { projects, repository, storage, service };
  };
  it('reads the frozen artifact within a bounded range after project and task validation', async () => {
    const { repository, storage, service } = detailSetup();
    const detail = await service.nodeDetail('p', 't', 'DOCUMENT_PARSE');
    expect(repository.findArtifact).toHaveBeenCalledWith('p', 't', 'doc');
    expect(storage.open).toHaveBeenCalledWith('frozen/parsed', { start: 0, end: 65535 });
    expect(detail.sources[0]?.fields.find((f) => f.key === 'excerpt')?.value).toBe(
      '产品名称\n青梅酱',
    );
    expect(JSON.stringify(detail)).not.toContain('frozen/parsed');
  });
  it('does not read files when project access fails', async () => {
    const { projects, repository, storage, service } = detailSetup();
    projects.get.mockRejectedValue(new Error('forbidden'));
    await expect(service.nodeDetail('p', 't', 'DOCUMENT_PARSE')).rejects.toThrow('forbidden');
    expect(repository.task).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });
  it('does not read parser files for other stages', async () => {
    const { storage, service } = detailSetup();
    await service.nodeDetail('p', 't', 'FUSION');
    expect(storage.open).not.toHaveBeenCalled();
  });
  it('does not turn a file-read error into a failed task', async () => {
    const { storage, service } = detailSetup();
    storage.open.mockRejectedValue(new Error('private backend endpoint'));
    const detail = await service.nodeDetail('p', 't', 'DOCUMENT_PARSE');
    expect(detail.status).toBe('SUCCEEDED');
    expect(detail.sources[0]?.warnings).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain('private backend');
  });
});
