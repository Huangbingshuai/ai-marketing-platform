import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import {
  WorkflowWorkingRepository,
  workingArtifactContentHash,
  type WorkingArtifactRecord,
  type WorkingArtifactUpsertInput,
} from './workflow-working.repository';

afterEach(() => vi.restoreAllMocks());

const input: WorkingArtifactUpsertInput = {
  kind: 'STRUCTURED',
  name: '成片',
  directory: 'EDITING_PROJECTS',
  type: 'TIMELINE_PROJECT',
  dependencies: [
    {
      sourceType: 'WORKING_ARTIFACT',
      sourceArtifactId: 'clip',
      sourceKey: 'render-clip:task',
      sourceRevision: 2,
      sourceHash: 'source-hash',
    },
  ],
};

function harness() {
  const source = {
    id: 'clip',
    projectId: 'p',
    workflowRunId: 'r',
    nodeId: 'SEGMENT_RENDER',
    artifactKey: 'render-clip:task',
    revision: 2,
    contentHash: 'source-hash',
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
    files: [],
    metadata: { branchSourceOwner: true },
    payload: { promptId: 'prompt', fileObjectId: 'file' },
  };
  const tx = {
    workflowRun: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'r', workflow: 'EFFECT', workflowSpace: 'EFFECT' }),
    },
    workingArtifact: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'film',
        contentHash: workingArtifactContentHash(input),
        files: [],
      }),
      findMany: vi.fn().mockResolvedValue([source]),
    },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
  const repository = new WorkflowWorkingRepository({
    $transaction: transaction,
  } as unknown as PrismaService);
  const projection = vi
    .spyOn(WorkflowWorkingRepository.prototype, 'listArtifacts')
    .mockResolvedValue([source] as unknown as WorkingArtifactRecord[]);
  const artifacts = Array.from({ length: 24 }, (_, index) => ({
    artifactKey: `timeline-project:t:${index}`,
    input,
  }));
  return { repository, projection, transaction, artifacts, source };
}

describe('atomic batch artifact confirmation', () => {
  it('uses a batch transaction budget and reads the render head once for 24 films', async () => {
    const { repository, projection, transaction, artifacts } = harness();
    const result = await repository.commitValidatedArtifacts('p', 'r', 'TEMPLATE_MIX', artifacts);
    expect(result).toHaveLength(24);
    expect(result.every((row) => row.unchanged)).toBe(true);
    expect(projection).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 120_000 });
    await repository.commitValidatedArtifacts('p', 'r', 'TEMPLATE_MIX', artifacts);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it('does not reuse source projections for single writes or render-source batches', async () => {
    const { repository, projection, artifacts, source } = harness();
    source.revision = 3; // Force shared-source fallback for these writes.
    projection.mockResolvedValue([
      { ...source, revision: 2 },
    ] as unknown as WorkingArtifactRecord[]);
    await repository.upsertArtifact('p', 'r', 'TEMPLATE_MIX', 'one', input);
    await repository.upsertArtifact('p', 'r', 'TEMPLATE_MIX', 'two', input);
    expect(projection).toHaveBeenCalledTimes(2);
    await repository.commitValidatedArtifacts('p', 'r', 'SEGMENT_RENDER', artifacts);
    expect(projection).toHaveBeenCalledTimes(26);
  });

  it('still rejects copied old media even if confirmed film content was unchanged', async () => {
    const { repository, projection, artifacts, source } = harness();
    projection.mockResolvedValue([
      { ...source, payload: { promptId: 'prompt', fileObjectId: 'new-file' } },
    ] as unknown as WorkingArtifactRecord[]);
    await expect(
      repository.commitValidatedArtifacts('p', 'r', 'TEMPLATE_MIX', artifacts),
    ).rejects.toThrow('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
  });

  it.each(['P2028', 'P2034'])(
    'retries rolled-back %s once with a fresh transaction',
    async (code) => {
      const { repository, transaction, artifacts, projection } = harness();
      const commit = vi
        .spyOn(repository, 'commitValidatedArtifactsInTransaction')
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('rolled back', { code, clientVersion: 'test' }),
        );
      await expect(
        repository.commitValidatedArtifacts('p', 'r', 'TEMPLATE_MIX', artifacts),
      ).resolves.toHaveLength(24);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(commit).toHaveBeenCalledTimes(2);
      expect(projection).toHaveBeenCalledTimes(1);
    },
  );

  it('rereads source heads when a completed attempt is rolled back', async () => {
    const { repository, transaction, artifacts, projection } = harness();
    const executeTransaction = transaction.getMockImplementation()!;
    transaction.mockImplementationOnce(async (callback) => {
      await executeTransaction(callback);
      throw new Prisma.PrismaClientKnownRequestError('transaction rolled back at commit', {
        code: 'P2034',
        clientVersion: 'test',
      });
    });
    await expect(
      repository.commitValidatedArtifacts('p', 'r', 'TEMPLATE_MIX', artifacts),
    ).resolves.toHaveLength(24);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it('bounds database retries and never retries business conflicts or arbitrary exceptions', async () => {
    const { repository, transaction, artifacts } = harness();
    const commit = vi.spyOn(repository, 'commitValidatedArtifactsInTransaction');
    const timeout = new Prisma.PrismaClientKnownRequestError('rolled back', {
      code: 'P2028',
      clientVersion: 'test',
    });
    commit.mockRejectedValue(timeout);
    await expect(
      repository.commitValidatedArtifacts('p', 'r', 'TEMPLATE_MIX', artifacts),
    ).rejects.toBe(timeout);
    expect(transaction).toHaveBeenCalledTimes(2);
    transaction.mockClear();
    commit.mockRejectedValue(new Error('WORKING_ARTIFACT_DEPENDENCY_CONFLICT'));
    await expect(
      repository.commitValidatedArtifacts('p', 'r', 'TEMPLATE_MIX', artifacts),
    ).rejects.toThrow('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
