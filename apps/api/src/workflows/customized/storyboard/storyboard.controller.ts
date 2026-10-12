/* eslint-disable @typescript-eslint/consistent-type-imports -- Nest injection and DTO validation require runtime decorator metadata. */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { StoryboardService } from './storyboard.service';
import {
  CreateScriptDto,
  EditScriptDto,
  SaveStoryboardSettingsDto,
  StartStoryboardDto,
  StoryboardDetailQueryDto,
  StoryboardScopeDto,
} from './storyboard.dto';
@Controller('projects/:projectId/workflows/customized/storyboard')
export class StoryboardController {
  constructor(private readonly service: StoryboardService) {}
  @Get() workspace(@Param('projectId', ParseUUIDPipe) p: string, @Query() q: StoryboardScopeDto) {
    return this.service.workspace(p, q.workflowRunId);
  }
  @Put('settings') settings(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Body() b: SaveStoryboardSettingsDto,
  ) {
    return this.service.settings(p, b);
  }
  @Post('tasks') @HttpCode(202) create(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Body() b: StartStoryboardDto,
  ) {
    return this.service.create(p, b);
  }
  @Get('tasks/:id') task(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.task(p, id);
  }
  @Get('tasks/:id/nodes/:node') detail(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('node') node: string,
    @Query() q: StoryboardDetailQueryDto,
  ) {
    return this.service.detail(p, id, node, q);
  }
  @Post('tasks/:id/retry') @HttpCode(202) retry(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.retry(p, id);
  }
  @Post('tasks/:id/cancel') cancel(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.retry(p, id, true);
  }
  @Post('scripts') manual(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Body() b: CreateScriptDto,
  ) {
    return this.service.manual(p, b);
  }
  @Put('scripts/:id') edit(
    @Param('projectId', ParseUUIDPipe) p: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: EditScriptDto,
  ) {
    return this.service.edit(p, id, b);
  }
}
