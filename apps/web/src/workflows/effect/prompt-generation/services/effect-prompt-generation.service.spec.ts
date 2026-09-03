import type { EffectPromptRun, GetEffectPromptWorkspaceData } from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEffectPromptCsv,
  loadEffectPromptNodeDetail,
  loadEffectPromptWorkspace,
  pollEffectPromptRun,
  saveEffectPromptItem,
} from './effect-prompt-generation.service';
import type { EffectPromptBatchResult } from '@ai-marketing/contracts';

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
  it('exports a spreadsheet-friendly CSV without internal fields', () => {
    const result = {
      renderProfile: {
        ratio: '9:16',
        resolution: '1080p',
        capabilityKey: 'SEEDANCE_2_0',
        sharedConstraints: { disabledElements: [], contentHash: 'private-constraint-hash' },
      },
      sharedPrompt: { compiledContent: '画面保持食品卫生，不出现未确认功效。' },
      items: [
        {
          id: 'private-item-id',
          code: 'P001',
          content: '=不应被表格识别为公式',
          targetDurationSeconds: 8,
          primaryPurpose: 'PRODUCT_DISPLAY',
          compatiblePurposes: ['PRODUCT_DISPLAY', 'HOOK'],
          dimensions: {
            narrative: '效果展示型',
            scene: '家庭厨房',
            persona: '成年人手部出镜',
            productRelation: '腊肠蒸熟后的饱满外观',
            camera: '微距慢推',
            emotion: '温暖食欲感',
          },
          insightBindings: [
            {
              factId: 'private-fact-id',
              field: 'VISUAL_FEATURES',
              value: '蒸熟后表面油亮',
              valueHash: 'private-value-hash',
              role: 'PRIMARY',
            },
          ],
        },
      ],
    } as unknown as EffectPromptBatchResult;

    const csv = buildEffectPromptCsv('广式腊肠', result);

    expect(csv).toContain('\uFEFF"商品","编号","Prompt 正文","片段时长（秒）"');
    expect(csv).toContain('"广式腊肠","P001","\'=不应被表格识别为公式","8"');
    expect(csv).toContain('"产品展示片段","钩子片段"');
    expect(csv).toContain('"视觉特征：蒸熟后表面油亮"');
    expect(csv).toContain('"画面保持食品卫生，不出现未确认功效。","9:16","1080p"');
    for (const internal of [
      'private-item-id',
      'private-fact-id',
      'private-value-hash',
      'private-constraint-hash',
      'productRelevance',
      'classificationStatus',
    ])
      expect(csv).not.toContain(internal);
  });

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

  it('关闭 AI 分析时只保存草稿且不发送评估参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        resultId: 'result-1',
        productId: 'product-1',
        revision: 2,
        result: {},
        savedAt: '2026-09-03T00:00:00.000Z',
        unchanged: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveEffectPromptItem(
      'project-1',
      'result-1',
      1,
      {
        content: '餐桌上，一双手把蒸熟的广式腊肠夹入碗中。',
        targetDurationSeconds: 5,
        useAiAnalysis: false,
      },
      undefined,
      3,
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ evaluateAfterSave: false, expectedRevision: 1 });
    expect(body).not.toHaveProperty('expectedSettingsRevision');
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body).not.toHaveProperty('useAiAnalysis');
  });
});
