import { Body, Controller, Module, Put } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureBodyParsers } from './configure-body-parsers';
import { HttpExceptionFilter } from './http-exception.filter';

@Controller('projects/:projectId/workflows/effect/template-mix')
class DraftProbeController {
  @Put('draft')
  draft(@Body() body: { content: string }) {
    return { length: body.content.length };
  }

  @Put('other')
  other(@Body() body: { content: string }) {
    return { length: body.content.length };
  }
}
@Module({ controllers: [DraftProbeController] })
class ProbeModule {}

describe('mix draft HTTP body limits', () => {
  let app: NestExpressApplication;
  let base: string;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
    configureBodyParsers(app);
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/projects/probe/workflows/effect/template-mix`;
  });
  afterAll(async () => {
    await app.close();
  });
  const send = (path: string, characters: number) =>
    fetch(base + path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ content: '中'.repeat(characters) }),
    });
  it('accepts a UTF-8 draft over 2 MB, including query strings', async () => {
    const response = await send('/draft?compactResponse=true', 800_000);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: 800_000 });
  });
  it('keeps unrelated endpoints bounded and reports 413 instead of 500', async () => {
    const response = await send('/other', 800_000);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'FILE_TOO_LARGE', success: false });
  });
  it('retains a finite 16 MB ceiling for draft saves', async () => {
    const response = await send('/draft', 5_700_000);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'FILE_TOO_LARGE', success: false });
  });
});
