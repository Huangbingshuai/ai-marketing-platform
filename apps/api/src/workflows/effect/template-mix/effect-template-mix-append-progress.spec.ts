import { describe, expect, it, vi } from 'vitest';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { EffectTemplateMixService } from './effect-template-mix.service';

describe('append classification progress only counts new material checkpoints', () => {
  it.each([
    [['old-0'], 0],
    [['old-0', 'new-1'], 1],
    [['old-0', 'new-1', 'new-1', 'foreign'], 1],
    [['old-0', 'new-1', 'new-2'], 2],
  ] as const)('counts %j without old roles or duplicate entries', async (ids, completed) => {
    const repository = {
      find: vi.fn().mockResolvedValue({
        id: 'task',
        workflowRunId: 'run',
        templateId: 'template',
        status: 'RUNNING',
        stage: 'CLASSIFYING',
        progress: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
        inputSnapshot: {
          materials: [...Array.from({ length: 20 }, (_, i) => `old-${i}`), 'new-1', 'new-2'].map(
            (id) => ({ id, code: id }),
          ),
          incremental: { materialIds: ['new-1', 'new-2'] },
        },
        classificationResult: ids.map((materialId) => ({ materialId, scores: { HOOK: 1 } })),
      }),
    };
    const service = new EffectTemplateMixService(
      {} as WorkflowWorkingService,
      repository as unknown as EffectTemplateMixAiRepository,
    );
    const run = await service.aiRun('project', 'task');
    expect(run.stageDetails?.CLASSIFYING).toMatchObject({ completed, total: 2 });
    expect(run.stageDetails?.CLASSIFYING?.inputSamples).toHaveLength(2);
    expect(run.stageDetails?.CLASSIFYING?.outputSamples).toHaveLength(completed);
    expect(run.stageDetails?.CLASSIFYING?.inputSamples.join(' ')).not.toContain('old-');
    expect(run.stageDetails?.CLASSIFYING?.outputSamples.join(' ')).not.toContain('old-');
    expect(run.progress).toBe(10);
  });
});
