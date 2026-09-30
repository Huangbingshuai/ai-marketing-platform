import { describe, expect, it, vi } from 'vitest';
import type { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectFinalOutputService } from '../final-output/effect-final-output.service';
import { EffectTemplateMixCompletionService } from './effect-template-mix-completion.service';

describe('smart-fill completion coordination', () => {
  it('creates pending output only after the filled timeline is confirmed', async () => {
    const order: string[] = [];
    const mix = { completeAiRun: vi.fn().mockImplementation(async () => {
      order.push('confirmed');
      return { workflowRunId: 'run', templateId: 'template', status: 'COMPLETED' };
    }) };
    const output = { upsertFromSmartFill: vi.fn().mockImplementation(async () => {
      order.push('pending');
    }) };
    const service = new EffectTemplateMixCompletionService(
      mix as unknown as EffectTemplateMixService,
      output as unknown as EffectFinalOutputService,
    );

    await service.complete('project', 'fill', 'token', []);

    expect(order).toEqual(['confirmed', 'pending']);
    expect(output.upsertFromSmartFill).toHaveBeenCalledWith('project', 'run', 'template');
  });

  it('does not create pending output when fill validation fails', async () => {
    const output = { upsertFromSmartFill: vi.fn() };
    const service = new EffectTemplateMixCompletionService(
      { completeAiRun: vi.fn().mockRejectedValue(new Error('旧任务')) } as unknown as EffectTemplateMixService,
      output as unknown as EffectFinalOutputService,
    );
    await expect(service.complete('project', 'fill', 'token', [])).rejects.toThrow('旧任务');
    expect(output.upsertFromSmartFill).not.toHaveBeenCalled();
  });
});
