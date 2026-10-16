import { AuthAccess } from '../../../platform/auth/auth-access.decorator';
/* eslint-disable @typescript-eslint/consistent-type-imports -- Nest injection and DTO validation require runtime decorator metadata. */
import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Headers,
  Inject,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoryboardRepository } from './storyboard.repository';
import {
  PublishScriptDto,
  StoryboardStepDto,
  StoryboardWorkerDto,
  StoryboardFinishDto,
} from './storyboard.dto';
@Injectable()
export class StoryboardWorkerGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
  canActivate(c: ExecutionContext) {
    const expected = this.config.get<string>('CUSTOMIZED_STORYBOARD_WORKER_TOKEN'),
      actual = c.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers[
        'x-worker-token'
      ];
    if (
      !expected ||
      typeof actual !== 'string' ||
      Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      throw new UnauthorizedException('Worker token 无效');
    return true;
  }
}
@Controller('internal/workers/customized-storyboard')
@AuthAccess('independent')
@UseGuards(StoryboardWorkerGuard)
export class StoryboardWorkerController {
  constructor(private readonly repository: StoryboardRepository) {}
  @Post('tasks/:id/claim') claim(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: StoryboardWorkerDto,
  ) {
    return this.repository.claim(b.projectId, id);
  }
  @Put('tasks/:id/heartbeat') heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: StoryboardWorkerDto,
  ) {
    return this.repository.heartbeat(b.projectId, id, token);
  }
  @Put('tasks/:id/steps') step(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: StoryboardStepDto,
  ) {
    return this.repository.step(b.projectId, id, token, b);
  }
  @Post('tasks/:id/scripts') publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: PublishScriptDto,
  ) {
    return this.repository.completeScript(b.projectId, id, token, b.script);
  }
  @Post('tasks/:id/finish') finish(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-attempt-token') token: string,
    @Body() b: StoryboardFinishDto,
  ) {
    return this.repository.finish(b.projectId, id, token, b);
  }
}
