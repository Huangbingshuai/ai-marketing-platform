import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ApiHttpException } from '../../common/api-http-exception';

/** Freeze public project reads and writes while the durable deletion job owns it. */
@Injectable()
export class ProjectDeletionGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<{
      params?: { projectId?: string };
      originalUrl: string;
      method: string;
    }>();
    const projectId = request.params?.projectId;
    // Leave invalid parameter handling to the UUID pipe, and Worker leases to internal APIs.
    if (
      !projectId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId) ||
      request.originalUrl.startsWith('/api/internal/')
    )
      return true;
    const path = request.originalUrl.split('?')[0]?.replace(/\/$/, '');
    if (
      (request.method === 'DELETE' && path === `/api/projects/${projectId}`) ||
      (request.method === 'GET' && path === `/api/projects/${projectId}/deletion`)
    )
      return true;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { deletionState: true },
    });
    if (project?.deletionState)
      throw new ApiHttpException('项目正在删除或等待重试，暂时不能进入。', 409, 'PROJECT_DELETING');
    return true;
  }
}
