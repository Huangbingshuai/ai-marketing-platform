import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import type { EffectTemplateMixAiTrim } from '@ai-marketing/contracts';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectFinalOutputService } from '../final-output/effect-final-output.service';
import { EffectPackagingService } from './effect-packaging.service';

/** Coordinates the two confirmed-node writes without making the mix and output services circular. */
@Injectable()
export class EffectTemplateMixCompletionService {
  private readonly logger = new Logger(EffectTemplateMixCompletionService.name);

  constructor(
    @Inject(EffectTemplateMixService) private readonly mix: EffectTemplateMixService,
    @Inject(EffectFinalOutputService) private readonly finalOutput: EffectFinalOutputService,
    @Optional() @Inject(EffectPackagingService) private readonly packaging?: EffectPackagingService,
  ) {}

  async resumeAppend(projectId: string, runId: string) {
    const result = await this.mix.aiRun(projectId, runId);
    const variantIds = result.outputVariantIds;
    if (result.operation !== 'APPEND' || result.status !== 'COMPLETED' || !variantIds?.length)
      throw new ConflictException('追加成片尚未完成');
    try {
      await this.mix.ensureAppendConfirmed(projectId, runId);
      await this.finalOutput.upsertFromSmartFill(
        projectId,
        result.workflowRunId,
        result.templateId,
        variantIds,
        Boolean(result.packageNewVariants),
      );
      if (result.packageNewVariants) {
        if (!this.packaging) throw new Error('Packaging coordinator unavailable');
        const packageRun = await this.packaging.createIncremental(projectId, runId);
        if (['COMPLETED', 'PARTIAL'].includes(packageRun.status))
          await this.finalOutput.upsertFromPackaging(
            projectId,
            result.workflowRunId,
            result.templateId,
            { publish: false, onlyVariantIds: variantIds },
          );
      }
      await this.mix.recordAppendContinuation(projectId, runId, false);
    } catch (error) {
      const retryable =
        !(error instanceof HttpException) || error.getStatus() >= 500 || error.getStatus() === 429;
      await this.mix.recordAppendContinuation(projectId, runId, true, retryable);
      throw error;
    }
    return this.mix.aiRun(projectId, runId);
  }

  async claim(projectId: string, runId: string) {
    const result = await this.mix.claimAiRun(projectId, runId);
    if (result.terminal) {
      const run = await this.mix.aiRun(projectId, runId);
      if (
        run.operation === 'APPEND' &&
        run.status === 'COMPLETED' &&
        [
          'APPEND_CONTINUATION_PENDING',
          'APPEND_CONTINUATION_RETRY_1',
          'APPEND_CONTINUATION_RETRY_2',
        ].includes(run.errorCode ?? '')
      ) {
        try {
          await this.resumeAppend(projectId, runId);
        } catch {
          /* The original Outbox automatically resumes recoverable continuation. */
        }
      }
    }
    return result;
  }

  async complete(
    projectId: string,
    runId: string,
    attemptToken: string,
    trims: EffectTemplateMixAiTrim[],
  ) {
    const result = await this.mix.completeAiRun(projectId, runId, attemptToken, trims);
    if (result.operation === 'APPEND') {
      try {
        return await this.resumeAppend(projectId, runId);
      } catch {
        return this.mix.aiRun(projectId, runId);
      }
    }
    // The timeline is confirmed first. A stale callback cannot create output, while a successful
    // fill can already be exported picture-only and later upgraded in place by packaging.
    try {
      await this.finalOutput.upsertFromSmartFill(
        projectId,
        result.workflowRunId,
        result.templateId,
      );
    } catch (error) {
      // Match packaging's best-effort post-commit sync: the confirmed timeline must not be reported
      // as failed after its worker lease is consumed. The output page can reconcile a missed sync.
      this.logger.warn(
        JSON.stringify({
          event: 'effect_smart_fill_output_sync_failed',
          projectId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return result;
  }
}
