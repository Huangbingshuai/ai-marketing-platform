import type { Project } from '@ai-marketing/contracts';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';

// DTO classes must remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateProjectDto } from './dto/create-project.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { ProjectService } from './project.service';

@Controller('projects')
export class ProjectController {
  constructor(@Inject(ProjectService) private readonly projectService: ProjectService) {}

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
