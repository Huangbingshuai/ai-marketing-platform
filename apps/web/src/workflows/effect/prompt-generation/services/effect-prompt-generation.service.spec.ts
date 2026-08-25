import type { EffectPromptRun, GetEffectPromptWorkspaceData } from '@ai-marketing/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginEffectPromptRun,
  downloadEffectPromptBatch,
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
  progress,
  currentNode: status === 'COMPLETED' ? 'COMPLETED' : 'CANDIDATE_GENERATION',
  warnings: [],
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
          settings: { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
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
      { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
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
      schemaVersion: 1,
      productId: 'product-1',
      resultId: 'result-1',
      revision: 3,
      exportedAt: '2026-08-25T00:00:00.000Z',
      result: {
        schemaVersion: 1,
        settings: { count: 10, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
        items: [],
        metrics: {
          targetCount: 10,
          acceptedCount: 0,
          generatedCandidateCount: 0,
          removedSemanticDuplicates: 0,
          removedVisualDuplicates: 0,
          removedDimensionConflicts: 0,
          semanticDuplicateRate: 0,
          visualOverlapRate: 0,
          replenishmentRounds: 0,
        },
        qualityStatus: 'NEEDS_REVIEW',
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(exported)));
    const download = await downloadEffectPromptBatch('project-1', 'result-1', '广式腊肠');
    expect(download.fileName).toBe('广式腊肠-差异化Prompt-0条.json');
    await expect(download.blob.text()).resolves.toContain('"resultId": "result-1"');
  });
});
