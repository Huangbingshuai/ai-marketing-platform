import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  storyboardStages,
  type StoryboardInput,
  type StoryboardStage,
} from '@ai-marketing/contracts';
import { isUUID } from 'class-validator';
import { ProjectService } from '../../../platform/project/project.service';
import { ApiHttpException } from '../../../common/api-http-exception';
import { StoryboardRepository, presentStoryboardTask } from './storyboard.repository';
import { storyboardDetail } from './storyboard-detail';
import type {
  CreateScriptDto,
  DeleteStoryboardScriptDto,
  EditScriptDto,
  SaveStoryboardSettingsDto,
  StartStoryboardDto,
  StoryboardDetailQueryDto,
} from './storyboard.dto';
@Injectable()
export class StoryboardService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private recovering = false;
  private readonly logger = new Logger(StoryboardService.name);
  constructor(
    @Inject(StoryboardRepository) private readonly repository: StoryboardRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.recovering) return;
      this.recovering = true;
      void this.repository
        .recoverExpired()
        .catch(() => this.logger.warn('分镜任务恢复稍后重试'))
        .finally(() => {
          this.recovering = false;
        });
    }, 30000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async workspace(p: string, r: string) {
    await this.projects.get(p);
    return this.repository.workspace(p, r);
  }
  async settings(p: string, b: SaveStoryboardSettingsDto) {
    await this.projects.get(p);
    return {
      revision: await this.repository.settings(
        p,
        b.workflowRunId,
        b.expectedRevision,
        b.settings,
        b.selectedScriptId,
      ),
    };
  }
  async create(p: string, b: StartStoryboardDto) {
    await this.projects.get(p);
    return this.repository.create(p, b.workflowRunId, b.expectedRevision, b.idempotencyKey, {
      creative:
        this.config.get<string>('CUSTOMIZED_STORYBOARD_CREATIVE_MODEL') ||
        'doubao-seed-2-1-pro-260915',
      detail:
        this.config.get<string>('CUSTOMIZED_STORYBOARD_DETAIL_MODEL') ||
        'doubao-seed-2-1-turbo-260628',
    });
  }
  async task(p: string, id: string) {
    await this.projects.get(p);
    return presentStoryboardTask(await this.repository.task(p, id));
  }
  async retry(p: string, id: string, cancel = false) {
    await this.projects.get(p);
    return this.repository.retry(p, id, cancel);
  }
  async detail(p: string, id: string, node: string, q: StoryboardDetailQueryDto) {
    await this.projects.get(p);
    const t = await this.repository.task(p, id);
    const input = t.inputSnapshot as unknown as StoryboardInput;
    if (!storyboardStages(input).some((s) => s.id === node))
      throw new ApiHttpException('执行节点不存在', 404, 'ASSET_NOT_FOUND');
    if (q.scriptId && !input.scriptIds.includes(q.scriptId))
      throw new ApiHttpException('方案不属于此任务', 404, 'ASSET_NOT_FOUND');
    return storyboardDetail(input, t.steps, node as StoryboardStage, q.scriptId, q.page);
  }
  async manual(p: string, b: CreateScriptDto) {
    await this.projects.get(p);
    if (!isUUID(b.script?.id))
      throw new ApiHttpException('脚本标识不正确', 400, 'VALIDATION_ERROR');
    return this.repository.manual(p, b.workflowRunId, b.script, b.origin);
  }
  async edit(p: string, id: string, b: EditScriptDto) {
    await this.projects.get(p);
    return this.repository.edit(p, id, b.action, b.expectedRevision, b.script);
  }
  async remove(p: string, id: string, b: DeleteStoryboardScriptDto) {
    await this.projects.get(p);
    return this.repository.remove(p, id, b.workflowRunId, b.expectedRevision);
  }
}
