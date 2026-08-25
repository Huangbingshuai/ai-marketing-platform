import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptOperation,
  EffectPromptStageStatus,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_OPERATIONS,
  EFFECT_PROMPT_STAGE_STATUSES,
} from '@ai-marketing/contracts';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PromptWorkspaceQueryDto {
  @IsUUID('4') workflowRunId!: string;
}

export class PromptResultQueryDto {
  @IsUUID('4') workflowRunId!: string;
  @Type(() => Number) @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 10;
  @IsOptional() @IsString() @MaxLength(200) query?: string;
  @IsOptional() @IsIn([...EFFECT_PROMPT_FRAGMENT_TYPES]) fragmentType?: EffectPromptFragmentType;
}

export class SavePromptSettingsDto {
  @IsUUID('4') workflowRunId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number | null;
  @Allow() settings!: EffectPromptBatchSettings;
}

export class StartPromptRunDto {
  @IsUUID('4') workflowRunId!: string;
  @IsIn([...EFFECT_PROMPT_OPERATIONS]) operation!: EffectPromptOperation;
  @IsOptional() @IsUUID('4') targetItemId?: string;
  @Type(() => Number) @IsInt() @Min(1) expectedSettingsRevision!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedResultRevision?: number;
  @IsString() @MaxLength(500) idempotencyKey!: string;
}

export class PromptItemDto {
  @IsIn([...EFFECT_PROMPT_FRAGMENT_TYPES]) fragmentType!: EffectPromptFragmentType;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EFFECT_PROMPT_LIMITS.maxMaterialTags)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  materialTags!: string[];
  @Type(() => Number)
  @IsInt()
  @Min(EFFECT_PROMPT_LIMITS.minDurationSeconds)
  @Max(EFFECT_PROMPT_LIMITS.maxDurationSeconds)
  targetDurationSeconds!: number;
  @Allow() dimensions!: EffectPromptDimensions;
  @IsString() @MaxLength(12_000) content!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class DeletePromptItemDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class ValidatePromptResultDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class WorkerProjectDto {
  @IsUUID('4') projectId!: string;
}

export class WorkerStageDto extends WorkerProjectDto {
  @IsIn([...EFFECT_PROMPT_STAGE_STATUSES]) status!: EffectPromptStageStatus;
  @IsString() @MaxLength(500) summary = '';
  @IsArray() @IsString({ each: true }) @MaxLength(500, { each: true }) warnings: string[] = [];
  @Allow() metadata: unknown = {};
}

export class WorkerShardDto extends WorkerProjectDto {
  @IsIn([...EFFECT_PROMPT_STAGE_STATUSES]) status!: EffectPromptStageStatus;
  @Allow() combinationPlan: unknown = [];
  @Allow() items: unknown = [];
  @IsArray() @IsString({ each: true }) @MaxLength(500, { each: true }) warnings: string[] = [];
  @IsOptional() @IsString() @MaxLength(120) errorCode?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) errorMessage?: string | null;
}

export class WorkerCompleteDto extends WorkerProjectDto {
  @Allow() result!: EffectPromptBatchResult;
}

export class WorkerFailDto extends WorkerProjectDto {
  @IsString() @MaxLength(120) errorCode!: string;
  @IsString() @MaxLength(1000) errorMessage!: string;
  @IsBoolean() retryable!: boolean;
  @IsArray() @IsString({ each: true }) @MaxLength(500, { each: true }) warnings: string[] = [];
}
