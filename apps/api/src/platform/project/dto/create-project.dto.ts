import type { CreateProjectRequest } from '@ai-marketing/contracts';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateProjectDto implements CreateProjectRequest {
  @IsString()
  @Matches(/\S/, { message: '项目名称不能为空' })
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
