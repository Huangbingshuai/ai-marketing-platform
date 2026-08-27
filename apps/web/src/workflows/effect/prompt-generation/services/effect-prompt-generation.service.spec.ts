import type { EffectPromptRun, GetEffectPromptWorkspaceData } from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
} from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginEffectPromptRun,
  downloadEffectPromptBatch,
  loadEffectPromptNodeDetail,
  loadEffectPromptRun,
  loadEffectPromptWorkspace,
  pollEffectPromptRun,
  savePromptSettings,
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
  graphVersion: 'V9_SIX_BRANCH_STRATEGY',
  progress,
  attemptCount: 1,
  maxAttempts: 3,
  currentNode: status === 'COMPLETED' ? 'COMPLETED' : 'GENERATE_HOOK',
  warnings: [],
  errorCode: null,
  errorMessage: null,
  promptResultId: status === 'COMPLETED' ? 'result-1' : null,
  nodes: [],
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:01.000Z',
});

afterEach(() => vi.unstubAllGlobals());

describe('effect prompt generation HTTP service', () => {
  it('loads the project-isolated workspace without using localStorage', async () => {
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
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      '/projects/project-1/workflows/effect/prompt-generation?workflowRunId=workflow-run-1',
    );
  });

  it('saves settings with CAS revision and starts an idempotent run', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          productId: 'product-1',
          settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
          settingsRevision: 4,
          savedAt: '2026-08-25T00:00:00.000Z',
          unchanged: false,
        }),
      )
      .mockResolvedValueOnce(response({ run: run('QUEUED', 0) }));
    vi.stubGlobal('fetch', fetchMock);

    await savePromptSettings(
      { projectId: 'project-1', workflowRunId: 'workflow-run-1' },
      'product-1',
      DEFAULT_EFFECT_PROMPT_SETTINGS,
      3,
    );
    const settingsInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(settingsInit.headers).toMatchObject({ 'If-Match': '3' });

    await beginEffectPromptRun('project-1', 'product-1', {
      workflowRunId: 'workflow-run-1',
      operation: 'BATCH_GENERATE',
      expectedSettingsRevision: 4,
    });
    const runBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body)) as {
      idempotencyKey: string;
    };
    expect(runBody.idempotencyKey).toMatch(/^effect-prompt-|^[0-9a-f-]{20,}$/u);
  });

  it('polls until a terminal result and reports each persisted update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ run: run('RUNNING', 45) }))
      .mockResolvedValueOnce(response({ run: run('COMPLETED', 100) }));
    vi.stubGlobal('fetch', fetchMock);
    const updates: number[] = [];
    const finalRun = await pollEffectPromptRun('project-1', 'prompt-run-1', {
      intervalMs: 0,
      onUpdate: (nextRun) => updates.push(nextRun.progress),
    });
    expect(finalRun.status).toBe('COMPLETED');
    expect(updates).toEqual([45, 100]);
  });

  it('keeps the safe truncation code and terminal message returned by the API', async () => {
    const failedRun: EffectPromptRun = {
      ...run('FAILED', 15),
      currentNode: 'STRATEGY_PLANNING',
      errorCode: 'AI_OUTPUT_TRUNCATED',
      errorMessage: '营销关系规划结果超过安全长度，任务已停止',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ run: failedRun })));

    await expect(loadEffectPromptRun('project-1', 'prompt-run-1')).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'AI_OUTPUT_TRUNCATED',
      errorMessage: '营销关系规划结果超过安全长度，任务已停止',
    });
  });

  it('loads expanded safe node fields and descriptions without rebuilding details locally', async () => {
    const detail = {
      nodeId: 'SEMANTIC_DEDUP' as const,
      status: 'SUCCEEDED' as const,
      summary: '语义重复代理校验完成',
      fields: [
        {
          label: '语义重复判定阈值',
          value: '0.82',
          description: '内容意图签名相同或三元组 Dice 达到阈值时计为重复。',
        },
      ],
      warnings: [],
      errorMessage: null,
      updatedAt: '2026-08-25T00:00:01.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(response({ detail }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadEffectPromptNodeDetail('project-1', 'prompt-run-1', 'SEMANTIC_DEDUP'),
    ).resolves.toEqual(detail);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      '/projects/project-1/workflows/effect/prompt-generation/runs/prompt-run-1/nodes/SEMANTIC_DEDUP',
    );
  });

  it('cancels recoverable polling through AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      pollEffectPromptRun('project-1', 'prompt-run-1', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('exports the authoritative server payload instead of rebuilding browser state', async () => {
    const exported = {
      schemaVersion: 5,
      productId: 'product-1',
      resultId: 'result-1',
      revision: 3,
      exportedAt: '2026-08-25T00:00:00.000Z',
      result: {
        schemaVersion: 5,
        settings: DEFAULT_EFFECT_PROMPT_SETTINGS,
        renderProfile: {
          ratio: '9:16',
          resolution: '1080p',
          capabilityKey: 'SEEDANCE_2_0',
          sharedConstraints: {
            disabledElements: ['品牌水印'],
            contentHash: 'hash-disabled',
          },
        },
        sharedPrompt: {
          schemaVersion: 1,
          sections: [
            {
              key: 'DISABLED_ELEMENTS',
              title: '禁用元素',
              source: 'SYSTEM',
              content: '画面中不得出现以下内容：品牌水印。',
              editable: false,
              sourceHash: 'hash-source',
            },
            {
              key: 'USER_ADDITIONAL',
              title: '补充共用内容',
              source: 'USER',
              content: '保持产品外观一致。',
              editable: true,
              sourceHash: 'hash-user',
            },
          ],
          compiledContent: '画面中不得出现以下内容：品牌水印。\n保持产品外观一致。',
          contentHash: 'hash-shared',
        },
        items: [],
        metrics: {
          targetCount: 10,
          acceptedCount: 0,
          generatedCandidateCount: 0,
          fallbackCount: 0,
          removedSemanticDuplicates: 0,
          removedVisualDuplicates: 0,
          removedDimensionConflicts: 0,
          semanticDuplicateRate: 0,
          visualOverlapRate: 0,
          replenishmentRounds: 0,
          fragmentTypeDistribution: EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => ({
            fragmentType,
            targetCount: 0,
            actualCount: 0,
          })),
          sellingPointCoverage: { required: [], covered: [], missing: [] },
          insightCoverage: {
            required: [],
            covered: [],
            missing: [],
            adaptive: [],
            deferred: [],
            excluded: [],
            appliedConstraints: [],
          },
          removedExecutionInvalid: 0,
          executionInvalidReasons: [],
        },
        qualityStatus: 'NEEDS_REVIEW',
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(exported)));
    const download = await downloadEffectPromptBatch('project-1', 'result-1', '广式腊肠');
    expect(download.fileName).toBe('广式腊肠-差异化Prompt-0条.json');
    await expect(download.blob.text()).resolves.toContain('"resultId": "result-1"');
    await expect(download.blob.text()).resolves.toContain('"sharedPrompt"');
    await expect(download.blob.text()).resolves.toContain(
      '"compiledContent": "画面中不得出现以下内容：品牌水印。\\n保持产品外观一致。"',
    );
  });
});
