import { ASSET_WORKFLOWS, ASSET_WORKFLOW_SPACES } from '@ai-marketing/contracts';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ListWorkingArtifactsQueryDto {
  @IsOptional()
  @IsUUID('4')
  workflowRunId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nodeId?: string;

  @IsOptional()
  @IsIn([...ASSET_WORKFLOWS])
  workflow?: (typeof ASSET_WORKFLOWS)[number];

  @IsOptional()
  @IsIn([...ASSET_WORKFLOW_SPACES])
  space?: (typeof ASSET_WORKFLOW_SPACES)[number];
}
