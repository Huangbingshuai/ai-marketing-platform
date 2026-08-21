import {
  ASSET_WORKFLOWS,
  ASSET_WORKFLOW_SPACES,
  type CreateProjectRequest,
} from '@ai-marketing/contracts';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateProjectDto implements CreateProjectRequest {
  @IsString()
  @Matches(/\S/, { message: '项目名称不能为空' })
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional() @IsString() @MaxLength(120) client?: string;
  @IsOptional() @IsString() @MaxLength(120) productName?: string;
  @IsOptional() @IsString() @MaxLength(80) iconKey?: string;
  @IsOptional() @IsIn([...ASSET_WORKFLOWS]) workflow?: CreateProjectRequest['workflow'];
  @IsOptional() @IsIn([...ASSET_WORKFLOW_SPACES]) space?: CreateProjectRequest['space'];
}
