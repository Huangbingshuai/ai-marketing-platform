import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service';
import { ProjectDeletionGuard } from './project-deletion.guard';
import { DeleteProjectDto } from './dto/delete-project.dto';
import { validate } from 'class-validator';

const id = '11111111-1111-4111-8111-111111111111';
const context = (method: string, path: string, projectId = id): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ method, originalUrl: path, params: { projectId } }),
    }),
  }) as ExecutionContext;

describe('project deletion freeze', () => {
  it.each(['QUEUED', 'RUNNING', 'FAILED'])(
    'blocks public reads/writes in %s',
    async (deletionState) => {
      const project = { findUnique: vi.fn().mockResolvedValue({ deletionState }) };
      const guard = new ProjectDeletionGuard({ project } as unknown as PrismaService);
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        await expect(
          guard.canActivate(context(method, `/api/projects/${id}/assets`)),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'PROJECT_DELETING' }),
        });
      }
      expect(project.findUnique).toHaveBeenCalledWith({
        where: { id },
        select: { deletionState: true },
      });
    },
  );
  it('keeps retry/status endpoints and protected internal Worker routes reachable', async () => {
    const project = { findUnique: vi.fn() };
    const guard = new ProjectDeletionGuard({ project } as unknown as PrismaService);
    for (const [method, path] of [
      ['DELETE', `/api/projects/${id}`],
      ['GET', `/api/projects/${id}/deletion`],
      ['POST', `/api/internal/projects/${id}/claim`],
    ]) {
      expect(await guard.canActivate(context(method!, path!))).toBe(true);
    }
    expect(project.findUnique).not.toHaveBeenCalled();
  });
  it('leaves invalid UUID validation to the pipe and ordinary projects accessible', async () => {
    const project = { findUnique: vi.fn().mockResolvedValue({ deletionState: null }) };
    const guard = new ProjectDeletionGuard({ project } as unknown as PrismaService);
    expect(await guard.canActivate(context('GET', '/api/projects/bad', 'bad'))).toBe(true);
    expect(project.findUnique).not.toHaveBeenCalled();
    expect(await guard.canActivate(context('GET', `/api/projects/${id}`))).toBe(true);
  });
});

describe('delete project context validation', () => {
  it('accepts omitted context for an unbound browser, rejects an invalid current ID', async () => {
    expect(await validate(new DeleteProjectDto())).toEqual([]);
    const valid = Object.assign(new DeleteProjectDto(), { currentProjectId: id });
    expect(await validate(valid)).toEqual([]);
    expect(
      (await validate(Object.assign(new DeleteProjectDto(), { currentProjectId: 'bad' })))[0]
        ?.property,
    ).toBe('currentProjectId');
  });
});
