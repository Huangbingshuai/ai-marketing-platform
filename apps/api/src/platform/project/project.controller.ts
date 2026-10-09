import type { DeleteProjectResult, Project } from '@ai-marketing/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  HttpCode,
} from '@nestjs/common';

// DTO classes must remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateProjectDto } from './dto/create-project.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DeleteProjectDto } from './dto/delete-project.dto';
import { ProjectService } from './project.service';
import { ProjectDeletionService } from './project-deletion.service';

@Controller('projects')
export class ProjectController {
  constructor(
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(ProjectDeletionService) private readonly deletionService: ProjectDeletionService,
  ) {}

  @Delete(':projectId')
  @HttpCode(202)
  remove(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() context: DeleteProjectDto,
  ): Promise<DeleteProjectResult> {
    return this.deletionService.remove(projectId, context);
  }

  @Get(':projectId/deletion')
  deletion(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
  ): Promise<DeleteProjectResult> {
    return this.deletionService.status(projectId);
  }

  @Post()
  create(@Body() input: CreateProjectDto): Promise<Project> {
    return this.projectService.create(input);
  }

  @Get()
  list(@Query() query: ListProjectsQueryDto): Promise<Project[]> {
    return this.projectService.list(query);
  }

  @Get(':projectId')
  get(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
  ): Promise<Project> {
    return this.projectService.get(projectId);
  }
}
