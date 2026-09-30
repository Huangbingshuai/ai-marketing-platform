import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EffectTemplateMixAiTrim } from '@ai-marketing/contracts';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectFinalOutputService } from '../final-output/effect-final-output.service';

/** Coordinates the two confirmed-node writes without making the mix and output services circular. */
@Injectable()
export class EffectTemplateMixCompletionService {
  private readonly logger = new Logger(EffectTemplateMixCompletionService.name);

  constructor(
    @Inject(EffectTemplateMixService) private readonly mix: EffectTemplateMixService,
    @Inject(EffectFinalOutputService) private readonly finalOutput: EffectFinalOutputService,
  ) {}

  async complete(projectId: string, runId: string, attemptToken: string,
    trims: EffectTemplateMixAiTrim[]) {
    const result = await this.mix.completeAiRun(projectId, runId, attemptToken, trims);
    // The timeline is confirmed first. A stale callback cannot create output, while a successful
    // fill can already be exported picture-only and later upgraded in place by packaging.
    try {
      await this.finalOutput.upsertFromSmartFill(
        projectId, result.workflowRunId, result.templateId,
      );
    } catch (error) {
      // Match packaging's best-effort post-commit sync: the confirmed timeline must not be reported
      // as failed after its worker lease is consumed. The output page can reconcile a missed sync.
      this.logger.warn(JSON.stringify({
        event: 'effect_smart_fill_output_sync_failed',
        projectId, runId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return result;
  }
}
