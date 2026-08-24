import {
  ASSET_DIRECTORIES,
  ASSET_STATUSES,
  ASSET_TYPES,
  ASSET_WORKFLOWS,
  ASSET_WORKFLOW_SPACES,
} from '@ai-marketing/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class ListAssetsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  keyword?: string;

  @IsOptional()
  @IsIn([...ASSET_DIRECTORIES])
  directory?: (typeof ASSET_DIRECTORIES)[number];

  @IsOptional()
  @IsIn([...ASSET_TYPES])
  type?: (typeof ASSET_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  tag?: string;

  @IsOptional() @IsIn([...ASSET_WORKFLOWS]) workflow?: (typeof ASSET_WORKFLOWS)[number];
  @IsOptional() @IsIn([...ASSET_WORKFLOW_SPACES]) space?: (typeof ASSET_WORKFLOW_SPACES)[number];
  @IsOptional() @IsIn([...ASSET_STATUSES]) status?: (typeof ASSET_STATUSES)[number];
  @IsOptional() @IsUUID('4') productId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(96) pageSize?: number;
}
