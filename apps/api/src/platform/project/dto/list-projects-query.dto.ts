import {
  ASSET_WORKFLOWS,
  ASSET_WORKFLOW_SPACES,
  type ProjectListQuery,
} from '@ai-marketing/contracts';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListProjectsQueryDto implements ProjectListQuery {
  @IsOptional() @IsString() @MaxLength(120) keyword?: string;
  @IsOptional() @IsIn([...ASSET_WORKFLOWS]) workflow?: ProjectListQuery['workflow'];
  @IsOptional() @IsIn([...ASSET_WORKFLOW_SPACES]) space?: ProjectListQuery['space'];
}
