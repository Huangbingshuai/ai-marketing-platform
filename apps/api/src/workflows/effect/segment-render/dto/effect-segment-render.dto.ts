import {
  EFFECT_PROMPT_RENDER_CAPABILITY_KEYS,
  EFFECT_SEGMENT_RENDER_EXPORT_FORMATS,
  EFFECT_SEGMENT_RENDER_LIMITS,
  EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS,
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
  IsNumber,
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

export class SegmentRenderRepairRegionDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(1) x!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(1) y!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(1) width!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(1) height!: number;
}

export class StartSegmentRenderRepairDto {
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
  @Type(() => Number) @IsInt() @Min(1) expectedSourceVersion!: number;
  @Type(() => Number) @IsInt() @Min(0) startMs!: number;
  @Type(() => Number)
  @IsInt()
  @Min(EFFECT_SEGMENT_RENDER_LIMITS.minRepairDurationMs)
  endMs!: number;
  @IsString()
  @IsNotEmpty()
  @MaxLength(EFFECT_SEGMENT_RENDER_LIMITS.maxRepairInstructionLength)
  instruction!: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentRenderRepairRegionDto)
  region?: SegmentRenderRepairRegionDto | null;
  @IsString() @IsNotEmpty() @MaxLength(500) idempotencyKey!: string;
}

export class DecideSegmentRenderRepairDto {
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
  @Type(() => Number) @IsInt() @Min(2) repairVersion!: number;
  @IsIn(EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS)
  decision!: (typeof EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS)[number];
  @IsString() @IsNotEmpty() @MaxLength(500) idempotencyKey!: string;
}

export class SegmentRenderTaskContentQueryDto {
  @IsOptional() @IsIn(['ACTIVE', 'REPAIR']) variant: 'ACTIVE' | 'REPAIR' = 'ACTIVE';
  @IsOptional() @IsIn(['VIDEO', 'POSTER']) kind: 'VIDEO' | 'POSTER' = 'VIDEO';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
}

export class ImportSegmentRenderMaterialsDto {
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
  @IsString() @IsNotEmpty() @MaxLength(500) idempotencyKey!: string;
  @IsString() @IsNotEmpty() @MaxLength(20_000) mappings!: string;
}

export class DeleteSegmentRenderMaterialsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EFFECT_SEGMENT_RENDER_LIMITS.maxTaskIdsPerOperation)
  @IsUUID('4', { each: true })
  taskIds!: string[];
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
  @IsString() @IsNotEmpty() @MaxLength(500) idempotencyKey!: string;
}

export class ExportSegmentRenderMaterialsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EFFECT_SEGMENT_RENDER_LIMITS.maxTaskIdsPerOperation)
  @IsUUID('4', { each: true })
  taskIds!: string[];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EFFECT_SEGMENT_RENDER_EXPORT_FORMATS.length)
  @IsIn(EFFECT_SEGMENT_RENDER_EXPORT_FORMATS, { each: true })
  formats!: (typeof EFFECT_SEGMENT_RENDER_EXPORT_FORMATS)[number][];
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
}

export class ValidateSegmentRenderBatchDto {
  @Type(() => Number) @IsInt() @Min(1) expectedBatchRevision!: number;
}

export class SegmentRenderWorkerProjectDto {
  @IsUUID('4') projectId!: string;
}

export class SegmentRenderWorkerReferenceImageQueryDto extends SegmentRenderWorkerProjectDto {
  @Type(() => Number) @IsInt() @Min(1) taskVersion!: number;
}

export class SegmentRenderWorkerReferenceVideoUrlDto extends SegmentRenderWorkerProjectDto {
  @Type(() => Number) @IsInt() @Min(1) taskVersion!: number;
}

export class SegmentRenderProviderVideoQueryDto {
  @Type(() => Number) @IsInt() @Min(1) taskVersion!: number;
  @Type(() => Number) @IsInt() @Min(1) expires!: number;
  @IsString() @IsNotEmpty() @MaxLength(256) signature!: string;
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
  @IsOptional() @IsString() @MaxLength(255) providerTaskId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() resetProviderTask?: boolean;
}
