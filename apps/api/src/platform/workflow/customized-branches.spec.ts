import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOMIZED_SOURCE_ARTIFACT_KEY,
  emptyCustomizedImportDraft,
  normalizeCustomizedImportDraft,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../generated/prisma/client';
import {
  beginCustomizedEdit,
  cancelCustomizedEdit,
  saveCustomizedVersion,
  activateCustomizedBranch,
  assertCustomizedImportEditable,
} from './customized-branches';
import {
  workingArtifactContentHash,
  type WorkflowWorkingRepository,
} from './workflow-working.repository';

const assetId = '77777777-7777-4777-8777-777777777777';
function fixture() {
  let sequence = 0;
  const runs: Record<string, any> = {
    root: {
      id: 'root',
      projectId: 'p',
      workflow: 'CUSTOMIZED',
      workflowSpace: 'CUSTOMIZED_PROJECT',
      activeKey: 'ACTIVE',
      status: 'ACTIVE',
      editSessionNodeId: null,
      parentWorkflowRunId: null,
      branchPublishedAt: null,
    },
  };
  const draft = {
    ...emptyCustomizedImportDraft(),
    requirements: '展示产品',
    materials: [{ assetId, assetVersion: 1, category: 'BRIEF' as const }],
  };
  const states: Record<string, any> = {
    root: {
      revision: 1,
      schemaVersion: 1,
      state: draft,
      contentHash: 'draft',
      executionInputHash: 'input',
      executionInputSchemaVersion: 1,
    },
  };
  const artifacts: Record<string, any> = {};
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === 'object' && 'in' in value && Array.isArray(value.in)
        ? value.in.includes(row[key])
        : row[key] === value,
    );
  const tx = {
    $queryRaw: vi.fn(),
    workflowRun: {
      findFirst: vi.fn(
        ({ where }) => Object.values(runs).find((row) => matches(row, where)) ?? null,
      ),
      create: vi.fn(({ data }) => {
        const row = {
          status: 'ACTIVE',
          branchPublishedAt: null,
          ...data,
          id: `child${++sequence}`,
        };
        runs[row.id] = row;
        return row;
      }),
      update: vi.fn(({ where, data }) => Object.assign(runs[where.id], data)),
      delete: vi.fn(({ where }) => {
        delete runs[where.id];
        delete states[where.id];
        delete artifacts[where.id];
      }),
    },
    workflowNodeState: {
      findUnique: vi.fn(
        ({ where }) => states[where.projectId_workflowRunId_nodeId.workflowRunId] ?? null,
      ),
      create: vi.fn(({ data }) => (states[data.workflowRunId] = structuredClone(data))),
    },
    workingArtifact: {
      findFirst: vi.fn(({ where }) => artifacts[where.workflowRunId] ?? null),
      create: vi.fn(({ data }) => (artifacts[data.workflowRunId] = structuredClone(data))),
    },
    assetVersion: {
      findMany: vi.fn(async ({ where }) => {
        if (!where.OR.length) return [];
        const rows = await tx.asset.findMany({
          where: { id: { in: where.OR.map((item: any) => item.assetId) } },
        });
        return rows.map((row: any) => ({
          assetId: row.id,
          version: row.currentVersion,
          originalFileName: row.originalFileName,
          mimeType: row.mimeType ?? 'text/markdown',
          storageKey: `files/${row.id}`,
          sizeBytes: 10,
          status: 'AVAILABLE',
        }));
      }),
    },
    asset: {
      findMany: vi.fn(({ where }) =>
        where.id.in.includes(assetId)
          ? [{ id: assetId, currentVersion: 1, originalFileName: 'brief.md' }]
          : [],
      ),
    },
  };
  const commit = vi.fn(async (_tx, _project, runId, nodeId, items) => {
    const input = items[0].input;
    const hash = workingArtifactContentHash(input);
    const previous = artifacts[runId];
    const unchanged = previous?.contentHash === hash;
    const record = (artifacts[runId] = {
      ...input,
      nodeId,
      artifactKey: CUSTOMIZED_SOURCE_ARTIFACT_KEY,
      revision: previous ? previous.revision + (unchanged ? 0 : 1) : 1,
      contentHash: hash,
      createdAt: previous?.createdAt ?? new Date(),
    });
    return [{ record, unchanged }];
  });
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    repository: {
      commitValidatedArtifactsInTransaction: commit,
    } as unknown as WorkflowWorkingRepository,
    runs,
    states,
    artifacts,
    assetQuery: tx.asset.findMany,
    versionQuery: tx.assetVersion.findMany,
    commit,
  };
}

describe('customized source version lifecycle', () => {
  it('guards uploads by project, active Run and isolated edit session', async () => {
    const f = fixture();
    await expect(assertCustomizedImportEditable(f.tx, 'p', 'root')).resolves.toMatchObject({
      id: 'root',
    });
    await expect(assertCustomizedImportEditable(f.tx, 'foreign', 'root')).rejects.toThrow(
      '版本已切换',
    );
    await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1);
    await expect(assertCustomizedImportEditable(f.tx, 'p', 'root')).rejects.toThrow('进入资料编辑');
    const child = await beginCustomizedEdit(f.tx, 'p', 'root');
    await expect(assertCustomizedImportEditable(f.tx, 'p', child.id)).resolves.toMatchObject({
      id: child.id,
    });
    await expect(assertCustomizedImportEditable(f.tx, 'p', 'root')).rejects.toThrow('版本已切换');
    await cancelCustomizedEdit(f.tx, 'p', child.id);
    await expect(assertCustomizedImportEditable(f.tx, 'p', child.id)).rejects.toThrow('版本已切换');
    f.runs.root.status = 'COMPLETED';
    await expect(assertCustomizedImportEditable(f.tx, 'p', 'root')).rejects.toThrow(
      '版本已切换或已完成',
    );
  });
  it('pins an existing file version even when the project asset has a newer version', async () => {
    const f = fixture();
    f.assetQuery.mockResolvedValue([
      { id: assetId, currentVersion: 2, originalFileName: 'new.md' },
    ]);
    f.versionQuery.mockResolvedValue([
      {
        assetId,
        version: 1,
        originalFileName: 'brief.md',
        mimeType: 'text/markdown',
        storageKey: 'old',
        sizeBytes: 10,
        status: 'AVAILABLE',
      },
    ]);
    await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1);
    expect(f.artifacts.root.payload.materials[0].assetVersion).toBe(1);
  });
  it('keeps an already-confirmed historical text-only version unchanged', async () => {
    const f = fixture();
    f.states.root.state.materials = [];
    f.artifacts.root = {
      payload: structuredClone(f.states.root.state),
      contentHash: 'historical-text',
      revision: 1,
    };
    const child = await beginCustomizedEdit(f.tx, 'p', 'root');
    const result = await saveCustomizedVersion(f.tx, f.repository, 'p', child.id, 1);
    expect(result).toMatchObject({ unchanged: true, createdBranch: false, run: { id: 'root' } });
    expect(f.artifacts.root.revision).toBe(1);
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('does not increment business revision when v2 areas and document categories are merged', async () => {
    const f = fixture();
    const old = {
      schemaVersion: 2,
      customerRequirements: '制作宣传片',
      productInformation: '规格以附件为准',
      materials: [{ assetId, assetVersion: 1, category: 'PRODUCT' }],
    };
    f.artifacts.root = { payload: old, contentHash: 'v2-baseline', revision: 1 };
    f.states.root.state = old;
    const child = await beginCustomizedEdit(f.tx, 'p', 'root');
    f.states[child.id].state = normalizeCustomizedImportDraft(old);
    const result = await saveCustomizedVersion(f.tx, f.repository, 'p', child.id, 1);
    expect(result.unchanged).toBe(true);
    expect(f.artifacts.root.payload).toEqual(old);
    expect(f.artifacts.root.revision).toBe(1);
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('rejects text-only and video-only source packages before committing', async () => {
    const f = fixture();
    f.states.root.state.materials = [];
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).rejects.toThrow(
      '请上传至少一份',
    );
    f.states.root.state.materials = [{ assetId, assetVersion: 1, category: 'BRIEF' }];
    f.assetQuery.mockImplementation(() => [
      { id: assetId, currentVersion: 1, originalFileName: 'sample.mp4' },
    ]);
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).rejects.toThrow(
      '资料文件类型不支持',
    );
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('projects a legacy payload without publishing a format-only edit or losing its constraints', async () => {
    const f = fixture();
    const old = {
      schemaVersion: 1,
      coreMessage: '展示产品',
      brandTone: '自然',
      disabledElements: ['不改包装'],
      durationSeconds: 30,
      aspectRatio: '16:9',
      materials: [{ assetId, assetVersion: 1, category: 'BRIEF' }],
    };
    f.artifacts.root = { payload: old, contentHash: 'legacy-hash', revision: 1 };
    f.states.root.state = old;
    const child = await beginCustomizedEdit(f.tx, 'p', 'root');
    f.states[child.id].state = normalizeCustomizedImportDraft(old);
    const result = await saveCustomizedVersion(f.tx, f.repository, 'p', child.id, 1);
    expect(result).toMatchObject({ unchanged: true, createdBranch: false, run: { id: 'root' } });
    expect(f.artifacts.root.payload).toEqual(old);
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('stores non-product image usage and rejects documents in the visual reference area', async () => {
    const f = fixture();
    f.states.root.state.materials = [
      { assetId, assetVersion: 1, category: 'VISUAL_REFERENCE', imageUsage: 'SCENE' },
    ];
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).rejects.toThrow(
      '只支持图片',
    );
    const imageId = '88888888-8888-4888-8888-888888888888';
    f.states.root.state.materials = [
      { assetId, assetVersion: 1, category: 'BRIEF' },
      { assetId: imageId, assetVersion: 1, category: 'VISUAL_REFERENCE', imageUsage: 'SCENE' },
    ];
    f.assetQuery.mockImplementation(() => [
      { id: assetId, currentVersion: 1, originalFileName: 'brief.md' },
      { id: imageId, currentVersion: 1, originalFileName: 'scene.png', mimeType: 'image/png' },
    ]);
    await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1);
    expect(
      f.artifacts.root.payload.materials.find(
        (item: { assetId: string }) => item.assetId === imageId,
      ),
    ).toMatchObject({
      category: 'VISUAL_REFERENCE',
      imageUsage: 'SCENE',
    });
  });
  it('commits the first version in place and repeated saves do not increment it', async () => {
    const f = fixture();
    const first = await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1);
    expect(first).toMatchObject({ createdBranch: false, unchanged: false });
    expect(f.artifacts.root.revision).toBe(1);
    expect((await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).unchanged).toBe(true);
    expect(f.artifacts.root.revision).toBe(1);
    expect(Object.keys(f.runs)).toEqual(['root']);
  });
  it('restores the same isolated child on repeated edit requests and cancels without changing the baseline', async () => {
    const f = fixture();
    await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1);
    const child = await beginCustomizedEdit(f.tx, 'p', 'root');
    expect((await beginCustomizedEdit(f.tx, 'p', 'root')).id).toBe(child.id);
    f.states[child.id].state.requirements = '编辑中';
    expect(f.states.root.state.requirements).toBe('展示产品');
    await expect(activateCustomizedBranch(f.tx, 'p', 'root', 'SOURCE_IMPORT')).rejects.toThrow(
      '请先保存或取消',
    );
    expect((await cancelCustomizedEdit(f.tx, 'p', child.id)).id).toBe('root');
    expect(f.artifacts.root.revision).toBe(1);
    expect(f.runs[child.id]).toBeUndefined();
  });
  it('same normalized content drops its hidden child rather than publishing an empty branch', async () => {
    const f = fixture();
    await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1);
    const child = await beginCustomizedEdit(f.tx, 'p', 'root');
    f.states[child.id].state.requirements = ' 展示产品 ';
    const saved = await saveCustomizedVersion(f.tx, f.repository, 'p', child.id, 1);
    expect(saved).toMatchObject({ run: { id: 'root' }, unchanged: true, createdBranch: false });
    expect(f.artifacts.root.revision).toBe(1);
  });
  it('publishes two successive changed revisions while preserving both historical branches', async () => {
    const f = fixture();
    await saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1);
    const second = await beginCustomizedEdit(f.tx, 'p', 'root');
    f.states[second.id].state.requirements = '第二版';
    expect((await saveCustomizedVersion(f.tx, f.repository, 'p', second.id, 1)).createdBranch).toBe(
      true,
    );
    const third = await beginCustomizedEdit(f.tx, 'p', second.id);
    f.states[third.id].state.requirements = '第三版';
    await saveCustomizedVersion(f.tx, f.repository, 'p', third.id, 1);
    expect([
      f.artifacts.root.revision,
      f.artifacts[second.id].revision,
      f.artifacts[third.id].revision,
    ]).toEqual([1, 2, 3]);
    await activateCustomizedBranch(f.tx, 'p', 'root', 'SOURCE_IMPORT');
    expect(f.runs.root.activeKey).toBe('ACTIVE');
    expect(f.artifacts[third.id].payload.requirements).toBe('第三版');
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', third.id, 1)).rejects.toThrow(
      '版本已切换',
    );
  });
  it('rejects stale draft revisions and changed or unavailable asset references before commit', async () => {
    const f = fixture();
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 2)).rejects.toThrow(
      '资料草稿已更新',
    );
    f.versionQuery.mockResolvedValueOnce([]);
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).rejects.toThrow(
      '资料版本不可用',
    );
    f.assetQuery.mockResolvedValueOnce([]);
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).rejects.toThrow(
      '资料版本不可用',
    );
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.assetQuery).toHaveBeenCalledWith({
      where: expect.objectContaining({
        projectId: 'p',
        storageWorkflow: 'CUSTOMIZED',
        workflowSpace: 'CUSTOMIZED_PROJECT',
        archivedAt: null,
      }),
    });
  });
  it('rejects another project or an effect Run without changing active pointers', async () => {
    const f = fixture();
    await expect(beginCustomizedEdit(f.tx, 'another', 'root')).rejects.toThrow('不存在');
    f.runs.root.workflow = 'EFFECT';
    await expect(activateCustomizedBranch(f.tx, 'p', 'root', 'SOURCE_IMPORT')).rejects.toThrow(
      '所选版本不可用',
    );
    expect(f.runs.root.activeKey).toBe('ACTIVE');
  });
  it('does not commit an incomplete or malformed source package', async () => {
    const f = fixture();
    f.states.root.state = emptyCustomizedImportDraft();
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).rejects.toThrow(
      '请上传至少一份视频创作简报文档',
    );
    f.states.root.state = { schemaVersion: 999 };
    await expect(saveCustomizedVersion(f.tx, f.repository, 'p', 'root', 1)).rejects.toThrow(
      '格式不正确',
    );
    expect(f.commit).not.toHaveBeenCalled();
  });
});
