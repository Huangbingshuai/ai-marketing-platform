import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CustomizedExtractionService } from './customized-extraction.service';
// Nest query/body validation needs concrete DTO classes in decorator metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ConfirmCustomizedExtractionDto,
  ExtractionScopeDto,
  StartCustomizedExtractionDto,
  UpdateCustomizedExtractionDto,
} from './customized-extraction.dto';
@Controller('projects/:projectId/workflows/customized/information-extraction')
export class CustomizedExtractionController {
  constructor(
    @Inject(CustomizedExtractionService) private readonly service: CustomizedExtractionService,
  ) {}
  @Get() workspace(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query() q: ExtractionScopeDto,
  ) {
    return this.service.workspace(projectId, q.workflowRunId);
  }
  @Post('tasks') @HttpCode(202) start(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: StartCustomizedExtractionDto,
  ) {
    return this.service.start(projectId, body);
  }
  @Get('tasks/:taskId') task(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.service.task(projectId, taskId);
  }
  @Get('tasks/:taskId/nodes/:nodeId') detail(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Param('nodeId') nodeId: string,
  ) {
    return this.service.nodeDetail(projectId, taskId, nodeId);
  }
  @Post('tasks/:taskId/retry') @HttpCode(202) retry(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.service.retry(projectId, taskId);
  }
  @Post('edit') edit(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: ExtractionScopeDto,
  ) {
    return this.service.edit(projectId, body.workflowRunId);
  }
  @Post('cancel-edit') cancel(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: ExtractionScopeDto,
  ) {
    return this.service.edit(projectId, body.workflowRunId, true);
  }
  @Put('results/:resultId') update(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('resultId', new ParseUUIDPipe()) resultId: string,
    @Body() body: UpdateCustomizedExtractionDto,
  ) {
    return this.service.update(projectId, resultId, body);
  }
  @Post('results/:resultId/confirm') confirm(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('resultId', new ParseUUIDPipe()) resultId: string,
    @Body() body: ConfirmCustomizedExtractionDto,
  ) {
    return this.service.confirm(projectId, resultId, body.expectedRevision);
  }
}
