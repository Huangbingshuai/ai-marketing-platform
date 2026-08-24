import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import type {
  PutWorkflowNodeStateData,
  WorkingArtifactListData,
  WorkflowNodeState,
} from '@ai-marketing/contracts';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { RawResponse } from '../../common/raw-response.decorator';
import { fileContentDisposition } from '../file/content-disposition';
// DTO classes remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ContentQueryDto } from '../asset/dto/content-query.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ListWorkingArtifactsQueryDto } from './dto/list-working-artifacts-query.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PutWorkflowNodeStateDto } from './dto/put-workflow-node-state.dto';
import { WorkflowWorkingService } from './workflow-working.service';

@Controller('projects/:projectId')
export class WorkflowWorkingController {
  constructor(@Inject(WorkflowWorkingService) private readonly service: WorkflowWorkingService) {}

  @Get('workflow-runs/:workflowRunId/nodes/:nodeId/state')
  getNodeState(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('workflowRunId', new ParseUUIDPipe({ version: '4' })) workflowRunId: string,
    @Param('nodeId') nodeId: string,
  ): Promise<WorkflowNodeState> {
    return this.service.getNodeState(projectId, workflowRunId, nodeId);
  }

  @Put('workflow-runs/:workflowRunId/nodes/:nodeId/state')
  putNodeState(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('workflowRunId', new ParseUUIDPipe({ version: '4' })) workflowRunId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: PutWorkflowNodeStateDto,
  ): Promise<PutWorkflowNodeStateData> {
    return this.service.putNodeState(projectId, workflowRunId, nodeId, body);
  }

  @Get('working-artifacts')
  listArtifacts(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Query() query: ListWorkingArtifactsQueryDto,
  ): Promise<WorkingArtifactListData> {
    return this.service.listArtifacts(projectId, query);
  }

  @Get('working-artifacts/:artifactId/content')
  @RawResponse()
  async content(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('artifactId', new ParseUUIDPipe({ version: '4' })) artifactId: string,
    @Headers('range') range: string | undefined,
    @Query() query: ContentQueryDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const content = await this.service.content(projectId, artifactId, range);
    const download = query.download === 'true';
    const inline = !download && content.previewKind !== 'DOWNLOAD';
    response.statusCode = content.partial ? 206 : 200;
    response.setHeader('content-type', content.mimeType);
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader(
      'content-disposition',
      fileContentDisposition(inline ? 'inline' : 'attachment', content.originalFileName),
    );
    response.setHeader('accept-ranges', content.previewKind === 'VIDEO' ? 'bytes' : 'none');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('cache-control', 'private, no-store');
    if (content.partial)
      response.setHeader(
        'content-range',
        `bytes ${content.start}-${content.end}/${content.sizeBytes}`,
      );
    await pipeline(content.stream, response);
  }
}
