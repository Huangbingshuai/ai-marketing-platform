import {
  EFFECT_PROMPT_RENDER_CAPABILITY_KEYS,
  EFFECT_SEGMENT_RENDER_LIMITS,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
} from '@ai-marketing/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SegmentRenderWorkspaceQueryDto {
  @IsUUID('4') workflowRunId!: string;
}

export class StartSegmentRenderBatchDto {
  @IsUUID('4') workflowRunId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedPromptArtifactRevision!: number;
  @Type(() => Number) @IsInt() @Min(0) expectedSettingsRevision!: number;
  @IsString() @IsNotEmpty() @MaxLength(500) idempotencyKey!: string;
}

export class SegmentRenderSettingsDto {
  @IsIn(SEEDANCE_RATIOS) ratio!: (typeof SEEDANCE_RATIOS)[number];
  @IsIn(SEEDANCE_RESOLUTIONS) resolution!: (typeof SEEDANCE_RESOLUTIONS)[number];
  @IsIn(EFFECT_PROMPT_RENDER_CAPABILITY_KEYS)
  capabilityKey!: (typeof EFFECT_PROMPT_RENDER_CAPABILITY_KEYS)[number];
}

export class SaveSegmentRenderSettingsDto {
  @IsUUID('4') workflowRunId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) expectedRevision!: number | null;
  @ValidateNested() @Type(() => SegmentRenderSettingsDto) settings!: SegmentRenderSettingsDto;
}

export class RegenerateSegmentRenderTasksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EFFECT_SEGMENT_RENDER_LIMITS.maxTaskIdsPerOperation)
  @IsUUID('4', { each: true })
  taskIds!: string[];
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
  @IsString() @IsNotEmpty() @MaxLength(500) idempotencyKey!: string;
}

export class ValidateSegmentRenderBatchDto {
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
}

export class SegmentRenderWorkerProjectDto {
  @IsUUID('4') projectId!: string;
}

export class SegmentRenderWorkerHeartbeatDto extends SegmentRenderWorkerProjectDto {
  @Type(() => Number) @IsInt() @Min(1) taskVersion!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(95) progress!: number;
  @IsOptional() @IsString() @MaxLength(255) providerTaskId?: string;
}

export class SegmentRenderWorkerCompleteDto extends SegmentRenderWorkerProjectDto {
  @Type(() => Number) @IsInt() @Min(1) taskVersion!: number;
  @IsString() @IsNotEmpty() @MaxLength(255) providerTaskId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) duration?: number;
  @IsOptional() @IsString() @MaxLength(20) ratio?: string;
  @IsOptional() @IsString() @MaxLength(20) resolution?: string;
}

export class SegmentRenderWorkerFailDto extends SegmentRenderWorkerProjectDto {
  @Type(() => Number) @IsInt() @Min(1) taskVersion!: number;
  @IsString() @IsNotEmpty() @MaxLength(120) errorCode!: string;
  @IsString() @IsNotEmpty() @MaxLength(1000) errorMessage!: string;
  @Type(() => Boolean) @IsBoolean() retryable!: boolean;
}
