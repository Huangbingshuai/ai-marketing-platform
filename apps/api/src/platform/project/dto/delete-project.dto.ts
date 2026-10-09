import type { DeleteProjectRequest } from '@ai-marketing/contracts';
import { IsOptional, IsUUID } from 'class-validator';

export class DeleteProjectDto implements DeleteProjectRequest {
  @IsOptional()
  @IsUUID('4')
  currentProjectId?: string;
}
