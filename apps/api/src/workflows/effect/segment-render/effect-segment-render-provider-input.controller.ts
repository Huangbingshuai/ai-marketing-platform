import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import { Controller, Get, Headers, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { RawResponse } from '../../../common/raw-response.decorator';
// DTOs are runtime imports for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SegmentRenderProviderVideoQueryDto } from './dto/effect-segment-render.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { EffectSegmentRenderService } from './effect-segment-render.service';

@Controller('provider-inputs/effect-segment-render')
export class EffectSegmentRenderProviderInputController {
  constructor(private readonly service: EffectSegmentRenderService) {}

  @Get(':taskId/:fileObjectId')
  @RawResponse()
  async video(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Param('fileObjectId', new ParseUUIDPipe({ version: '4' })) fileObjectId: string,
    @Headers('range') range: string | undefined,
    @Query() query: SegmentRenderProviderVideoQueryDto,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const content = await this.service.providerReferenceVideo(
      taskId,
      fileObjectId,
      query.taskVersion,
      query.expires,
      query.signature,
      range,
    );
    response.statusCode = content.partial ? 206 : 200;
    response.setHeader('content-type', content.mimeType);
    response.setHeader('content-length', String(content.contentLength));
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (content.partial)
      response.setHeader(
        'content-range',
        `bytes ${content.start}-${content.end}/${content.sizeBytes}`,
      );
    await pipeline(content.stream, response);
  }
}
