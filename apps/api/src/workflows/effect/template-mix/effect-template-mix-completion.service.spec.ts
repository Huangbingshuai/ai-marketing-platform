import { describe, expect, it, vi } from 'vitest';
import type { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectFinalOutputService } from '../final-output/effect-final-output.service';
import { EffectTemplateMixCompletionService } from './effect-template-mix-completion.service';
import type { EffectPackagingService } from './effect-packaging.service';

describe('smart-fill completion coordination', () => {
  function appendHarness(packageNewVariants = true) {
    const run = { workflowRunId: 'run', templateId: 't', status: 'COMPLETED', operation: 'APPEND',
      outputVariantIds: ['new-film'], packageNewVariants };
    const mix = { aiRun: vi.fn().mockResolvedValue(run), ensureAppendConfirmed: vi.fn(), recordAppendContinuation: vi.fn() };
    const output = { upsertFromSmartFill: vi.fn(), upsertFromPackaging: vi.fn() };
    const packaging = { createIncremental: vi.fn().mockResolvedValue({ status: 'QUEUED' }) };
    const service = new EffectTemplateMixCompletionService(mix as unknown as EffectTemplateMixService,
      output as unknown as EffectFinalOutputService, packaging as unknown as EffectPackagingService);
    return { mix, output, packaging, service };
  }
  it('only synchronizes and packages the new IDs without a branch switch', async () => {
    const { mix, output, packaging, service } = appendHarness();
    await service.resumeAppend('p', 'fill');
    expect(output.upsertFromSmartFill).toHaveBeenCalledWith('p', 'run', 't', ['new-film'], true);
    expect(packaging.createIncremental).toHaveBeenCalledWith('p', 'fill');
    expect(mix.recordAppendContinuation).toHaveBeenCalledWith('p', 'fill', false);
  });
  it('retains picture-only behavior for templates never successfully packaged', async () => {
    const { packaging, service, output, mix } = appendHarness(false);
    await service.resumeAppend('p', 'fill');
    expect(packaging.createIncremental).not.toHaveBeenCalled();
    expect(output.upsertFromSmartFill).toHaveBeenCalledWith('p', 'run', 't', ['new-film'], false);
    expect(output.upsertFromPackaging).not.toHaveBeenCalled();
    expect(mix.recordAppendContinuation).toHaveBeenCalledWith('p', 'fill', false);
  });
  it('exposes failed continuation and repairs output sync from an already finished package', async () => {
    const { mix, output, packaging, service } = appendHarness();
    packaging.createIncremental.mockRejectedValueOnce(new Error('输出同步失败'));
    await expect(service.resumeAppend('p', 'fill')).rejects.toThrow('输出同步失败');
    expect(mix.recordAppendContinuation).toHaveBeenCalledWith('p', 'fill', true);
    packaging.createIncremental.mockResolvedValue({ status: 'COMPLETED' });
    await service.resumeAppend('p', 'fill');
    expect(output.upsertFromPackaging).toHaveBeenCalledWith('p', 'run', 't', { publish: false, onlyVariantIds: ['new-film'] });
  });
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
