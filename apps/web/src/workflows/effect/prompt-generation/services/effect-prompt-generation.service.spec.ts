import type { EffectPromptRun, GetEffectPromptWorkspaceData } from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadEffectPromptNodeDetail,
  loadEffectPromptWorkspace,
  pollEffectPromptRun,
} from './effect-prompt-generation.service';

const response = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const run = (status: EffectPromptRun['status'], progress: number): EffectPromptRun => ({
  id: 'prompt-run-1',
  projectId: 'project-1',
  workflowRunId: 'workflow-run-1',
  productId: 'product-1',
  operation: 'BATCH_GENERATE',
  targetItemId: null,
  status,
  progress,
  attemptCount: 1,
  maxAttempts: 3,
  currentNode: status === 'COMPLETED' ? 'COMPLETED' : 'COHERENT_CREATIVE_GENERATION',
  warnings: [],
  errorCode: null,
  errorMessage: null,
  promptResultId: status === 'COMPLETED' ? 'result-1' : null,
  nodes: [],
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:01.000Z',
});

afterEach(() => vi.unstubAllGlobals());

describe('effect prompt generation HTTP service', () => {
  it('直接读取项目隔离的当前工作区', async () => {
    const workspace: GetEffectPromptWorkspaceData = {
      projectId: 'project-1',
      workflowRunId: 'workflow-run-1',
      products: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(response(workspace));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      loadEffectPromptWorkspace({ projectId: 'project-1', workflowRunId: 'workflow-run-1' }),
    ).resolves.toEqual(workspace);
  });

  it('轮询到后端终态并逐次报告真实进度', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response({ run: run('RUNNING', 45) }))
        .mockResolvedValueOnce(response({ run: run('COMPLETED', 100) })),
    );
    const updates: number[] = [];
    const finalRun = await pollEffectPromptRun('project-1', 'prompt-run-1', {
      intervalMs: 0,
      onUpdate: (nextRun) => updates.push(nextRun.progress),
    });
    expect(finalRun.status).toBe('COMPLETED');
    expect(updates).toEqual([45, 100]);
  });

  it('按当前节点标识读取服务端安全详情', async () => {
    const detail = {
      nodeId: 'FACT_VISUAL_STRATEGY_COMPILATION' as const,
      status: 'SUCCEEDED' as const,
      summary: '事实视觉使用策略已编译',
      sections: [],
      warnings: [],
      errorMessage: null,
      updatedAt: '2026-08-31T00:00:01.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(response({ detail }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      loadEffectPromptNodeDetail('project-1', 'prompt-run-1', 'FACT_VISUAL_STRATEGY_COMPILATION'),
    ).resolves.toEqual(detail);
  });
});
