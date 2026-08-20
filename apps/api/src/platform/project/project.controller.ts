import type { Project } from '@ai-marketing/contracts';
import { Body, Controller, Inject, Post } from '@nestjs/common';

// DTO classes must remain runtime imports so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectService } from './project.service';

@Controller('projects')
export class ProjectController {
  constructor(@Inject(ProjectService) private readonly projectService: ProjectService) {}

  @Post()
  create(@Body() input: CreateProjectDto): Promise<Project> {
    return this.projectService.create(input);
  }
}
