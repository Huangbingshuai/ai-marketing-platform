import {
  ASSET_DIRECTORIES,
  ASSET_TYPES,
  ASSET_WORKFLOWS,
  ASSET_WORKFLOW_SPACES,
} from '@ai-marketing/contracts';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ImportAssetDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn([...ASSET_DIRECTORIES])
  directory!: (typeof ASSET_DIRECTORIES)[number];

  @IsIn([...ASSET_TYPES])
  type!: (typeof ASSET_TYPES)[number];

  @IsString()
  tags!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional() @IsIn([...ASSET_WORKFLOWS]) storageWorkflow?: (typeof ASSET_WORKFLOWS)[number];
  @IsOptional()
  @IsIn([...ASSET_WORKFLOW_SPACES])
  workflowSpace?: (typeof ASSET_WORKFLOW_SPACES)[number];
}
