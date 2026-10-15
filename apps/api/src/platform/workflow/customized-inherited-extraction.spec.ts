import { describe, expect, it, vi } from 'vitest';
import { emptyCustomizedBrief } from '@ai-marketing/contracts';
import type { Prisma } from '../../generated/prisma/client';
import { readCustomizedExtractionResult } from './customized-inherited-extraction';

describe('customized frozen extraction projection', () => {
  const fields = {
    ...emptyCustomizedBrief(),
    productName: '旧版充电器',
    sellingPoints: ['折叠插脚'],
  };
  const candidate = {
    fields,
    fieldSources: { productName: [{ assetId: 'doc', assetVersion: 1, location: '第1页' }] },
    issues: [],
  };
  const origin = {
    id: 'result',
    workflowRunId: 'origin',
    draftResult: candidate,
    generatedResult: candidate,
    manualOverrides: {},
    revision: 3,
    taskId: 'task',
  };
  function fixture(changed = false) {
    const tx = {
      customizedExtractionResult: {
        findUnique: vi.fn(async ({ where }) =>
          where.projectId_workflowRunId.workflowRunId === 'origin'
            ? {
                ...origin,
                draftResult: changed
                  ? { ...candidate, fields: { ...fields, productName: '祖先新版本' } }
                  : candidate,
              }
            : null,
        ),
      },
      workingArtifact: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'copy',
          workflowRunId: 'script',
          payload: fields,
          sourceArtifactId: 'oldest',
          dependencies: [
            {
              sourceType: 'WORKING_ARTIFACT',
              sourceKey: 'customized-brief',
              sourceArtifactId: 'immediate',
            },
          ],
        }),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'immediate', workflowRunId: 'origin', sourceArtifactId: null, dependencies: [] },
          ]),
      },
    };
    return tx;
  }
  it('returns inherited frozen fields and evidence without writes, scoped to the same project and workflow', async () => {
    const tx = fixture();
    const result = await readCustomizedExtractionResult(
      tx as unknown as Prisma.TransactionClient,
      'p',
      'script',
    );
    expect(result).toMatchObject({
      inherited: true,
      evidenceMatches: true,
      record: { draftResult: candidate },
    });
    expect(tx.workingArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'p',
          id: { in: ['immediate', 'oldest'] },
          artifactKey: 'customized-brief',
          nodeId: 'INFORMATION_EXTRACTION',
          workflowRun: { workflow: 'CUSTOMIZED', workflowSpace: 'CUSTOMIZED_PROJECT' },
        },
      }),
    );
  });
  it('does not leak the origin latest draft, evidence, conflicts or manual overrides into a frozen branch', async () => {
    const tx = fixture(true);
    const result = await readCustomizedExtractionResult(
      tx as unknown as Prisma.TransactionClient,
      'p',
      'script',
    );
    expect(result?.record.draftResult).toEqual({ fields, fieldSources: {}, issues: [] });
    expect(result?.evidenceMatches).toBe(false);
  });
  it('keeps a real local editable result and never resolves siblings', async () => {
    const tx = fixture();
    tx.customizedExtractionResult.findUnique.mockResolvedValueOnce(origin);
    expect(
      (
        await readCustomizedExtractionResult(
          tx as unknown as Prisma.TransactionClient,
          'p',
          'script',
        )
      )?.inherited,
    ).toBe(false);
    expect(tx.workingArtifact.findFirst).not.toHaveBeenCalled();
  });
  it('does not reuse evidence from a different document snapshot even when fields happen to match', async () => {
    const tx = fixture();
    const result = await readCustomizedExtractionResult(
      tx as unknown as Prisma.TransactionClient,
      'p',
      'script',
      'another-source-fingerprint',
    );
    expect(result?.evidenceMatches).toBe(false);
    expect(result?.record.draftResult).toEqual({ fields, fieldSources: {}, issues: [] });
  });
  it('terminates a malformed inheritance cycle instead of falling back to unrelated results', async () => {
    const tx = fixture();
    tx.workingArtifact.findMany.mockResolvedValue([
      { id: 'copy', workflowRunId: 'script', sourceArtifactId: 'copy', dependencies: [] },
    ]);
    expect(
      await readCustomizedExtractionResult(
        tx as unknown as Prisma.TransactionClient,
        'p',
        'script',
      ),
    ).toBeNull();
    expect(tx.workingArtifact.findMany).toHaveBeenCalledTimes(1);
  });
});
