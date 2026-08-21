import {
  ASSET_DIRECTORIES,
  ASSET_TYPES,
  ASSET_WORKFLOWS,
  ASSET_WORKFLOW_SPACES,
  type StoreArtifactInput,
  type StoreArtifactsRequest,
} from '@ai-marketing/contracts';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class StoreArtifactDto implements StoreArtifactInput {
  @IsString() @Matches(/\S/) @MaxLength(500) idempotencyKey!: string;
  @IsString() @Matches(/\S/) @MaxLength(120) name!: string;
  @IsIn([...ASSET_DIRECTORIES]) directory!: StoreArtifactInput['directory'];
  @IsIn([...ASSET_TYPES]) type!: StoreArtifactInput['type'];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsString() @MaxLength(255) sourceArtifactId?: string;
  @IsOptional() @IsString() @MaxLength(255) sourceRunId?: string;
  @IsOptional() @IsString() @MaxLength(255) sourceNode?: string;
  @IsOptional() @IsString() @MaxLength(255) sourceShot?: string;
  @IsOptional() @IsString() @MaxLength(120) assetClass?: string;
  @IsOptional() @IsString() @MaxLength(160) businessType?: string;
  @IsOptional() @IsString() @MaxLength(160) contentKind?: string;
  @IsOptional() @Allow() content?: unknown;
  @IsOptional() @Allow() businessData?: unknown;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  views?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @Allow()
  dependencies?: StoreArtifactInput['dependencies'];
}

export class StoreArtifactsDto implements StoreArtifactsRequest {
  @IsIn([...ASSET_WORKFLOWS]) workflow!: StoreArtifactsRequest['workflow'];
  @IsIn([...ASSET_WORKFLOW_SPACES]) space!: StoreArtifactsRequest['space'];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StoreArtifactDto)
  assets!: StoreArtifactDto[];
}
