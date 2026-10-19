import 'reflect-metadata';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import * as dtos from './customized-extraction.dto';

// Vitest's source transform does not reproduce TypeScript's production decorator
// metadata. Compile the real controller with the production compiler options;
// otherwise importing a DTO as type-only can pass unit tests and fail in Nest.
function compiledController() {
  const filename = resolve(__dirname, 'customized-extraction.controller.ts');
  const configPath = resolve(__dirname, '../../../../tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram([filename], options);
  let outputText = '';
  program.emit(program.getSourceFile(filename), (name, text) => {
    if (name.endsWith('customized-extraction.controller.js')) outputText = text;
  });
  if (!outputText) throw new Error('Production controller compilation did not emit JavaScript');
  const exports: Record<string, any> = {};
  const require = createRequire(filename);
  class Service {}
  runInNewContext(outputText, {
    exports,
    Reflect,
    Object,
    Function,
    String,
    Number,
    Boolean,
    Array,
    Buffer,
    Date,
    require: (name: string) => {
      if (name === './customized-extraction.dto') return dtos;
      if (name === './customized-extraction.service')
        return { CustomizedExtractionService: Service };
      return require(name);
    },
  });
  return { Controller: exports.CustomizedExtractionController, Service };
}

describe('compiled customized extraction DTO validation', () => {
  const { Controller, Service } = compiledController();
  const projectId = 'edc219c3-fa7f-4991-9540-0f3cb20d3836';
  const runId = '990d1c4c-8743-4aff-8e46-467e9f5d2c20';
  const sourceId = 'e6e83282-0eb8-4aa0-b9fe-15f6c8b30e09';
  const service = {
    workspace: vi.fn((project: string, run: string) => ({
      projectId: project,
      workflowRunId: run,
    })),
    start: vi.fn((project: string, body: unknown) => ({ projectId: project, body })),
  };
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let base: string;

  beforeAll(async () => {
    @Module({ controllers: [Controller], providers: [{ provide: Service, useValue: service }] })
    class ValidationTestModule {}
    app = await NestFactory.create(ValidationTestModule, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/projects/${projectId}/workflows/customized/information-extraction`;
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['workspace', 1, dtos.ExtractionScopeDto],
    ['start', 1, dtos.StartCustomizedExtractionDto],
    ['edit', 1, dtos.ExtractionScopeDto],
    ['cancel', 1, dtos.ExtractionScopeDto],
    ['update', 2, dtos.UpdateCustomizedExtractionDto],
    ['confirm', 2, dtos.ConfirmCustomizedExtractionDto],
  ] as const)('retains the runtime DTO for %s', (method, index, expected) => {
    expect(Reflect.getMetadata('design:paramtypes', Controller.prototype, method)?.[index]).toBe(
      expected,
    );
  });

  it('passes valid project and Run identifiers through the actual HTTP validation pipe', async () => {
    const response = await fetch(`${base}?workflowRunId=${runId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId, workflowRunId: runId });
    expect(service.workspace).toHaveBeenLastCalledWith(projectId, runId);
  });

  it.each([
    '',
    '?workflowRunId=invalid',
    `?workflowRunId=${runId}&unexpected=1`,
    `?workflowRunId=${runId}&workflowRunId=${runId}`,
  ])('still rejects missing, malformed, additional or repeated query values: %s', async (query) => {
    const calls = service.workspace.mock.calls.length;
    expect((await fetch(`${base}${query}`)).status).toBe(400);
    expect(service.workspace).toHaveBeenCalledTimes(calls);
  });

  it('accepts inherited scope metadata in task creation without creating a real task', async () => {
    const body = {
      workflowRunId: runId,
      sourceArtifactId: sourceId,
      sourceRevision: 1,
      idempotencyKey: 'controlled-validation-test',
    };
    const response = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ projectId, body });
    expect(service.start.mock.calls.at(-1)?.[1]).toBeInstanceOf(dtos.StartCustomizedExtractionDto);
  });

  it('rejects unknown task body fields with the whitelist still enabled', async () => {
    const response = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowRunId: runId,
        sourceArtifactId: sourceId,
        sourceRevision: 1,
        idempotencyKey: 'controlled-validation-test',
        unexpected: true,
      }),
    });
    expect(response.status).toBe(400);
  });
});
