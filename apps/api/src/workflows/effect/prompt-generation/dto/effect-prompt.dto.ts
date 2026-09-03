import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptOperation,
  EffectPromptPurposeMatchMode,
  EffectPromptShardPhase,
  EffectPromptStageStatus,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_OPERATIONS,
  EFFECT_PROMPT_PURPOSE_MATCH_MODES,
  EFFECT_PROMPT_REGENERATION_MODES,
  EFFECT_PROMPT_REGENERATION_REASONS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_SHARD_PHASES,
  EFFECT_PROMPT_STAGE_STATUSES,
} from '@ai-marketing/contracts';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
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
  @IsOptional() @IsIn([...EFFECT_PROMPT_FRAGMENT_TYPES]) purpose?: EffectPromptFragmentType;
  @IsOptional()
  @IsIn([...EFFECT_PROMPT_PURPOSE_MATCH_MODES])
  purposeMatch?: EffectPromptPurposeMatchMode;
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
  @IsOptional() @IsString() @MaxLength(500) regenerationInstruction?: string;
  @IsOptional() @Allow() replacementDimensions?: EffectPromptDimensions;
  @IsOptional()
  @IsIn([...EFFECT_PROMPT_REGENERATION_MODES])
  regenerationMode?: (typeof EFFECT_PROMPT_REGENERATION_MODES)[number];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EFFECT_PROMPT_REGENERATION_REASONS.length)
  @IsIn([...EFFECT_PROMPT_REGENERATION_REASONS], { each: true })
  regenerationReasons?: Array<(typeof EFFECT_PROMPT_REGENERATION_REASONS)[number]>;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EFFECT_PROMPT_DIMENSIONS.length)
  @IsIn(EFFECT_PROMPT_DIMENSIONS.map(({ key }) => key), { each: true })
  preservedDimensions?: Array<(typeof EFFECT_PROMPT_DIMENSIONS)[number]['key']>;
  @Type(() => Number) @IsInt() @Min(1) expectedSettingsRevision!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedResultRevision?: number;
  @IsString() @MaxLength(500) idempotencyKey!: string;
}

export class ApplyPromptRegenerationDto {
  @IsUUID('4') candidateId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @IsString() @MaxLength(500) idempotencyKey!: string;
}

export class UndoPromptRegenerationDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @IsString() @MaxLength(500) idempotencyKey!: string;
}

export class PromptItemDto {
  @Allow() dimensions!: EffectPromptDimensions;
  @IsString() @MaxLength(12_000) content!: string;
  @Type(() => Number)
  @IsInt()
  @Min(EFFECT_PROMPT_LIMITS.minDurationSeconds)
  @Max(EFFECT_PROMPT_LIMITS.maxDurationSeconds)
  targetDurationSeconds!: number;
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class DeletePromptItemDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class UpdatePromptSharedPromptDto {
  @IsString() @MaxLength(60_000) content!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class ValidatePromptResultDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class WorkerProjectDto {
  @IsUUID('4') projectId!: string;
}

export class WorkerShardQueryDto extends WorkerProjectDto {
  @IsOptional() @IsIn([...EFFECT_PROMPT_SHARD_PHASES]) phase?: EffectPromptShardPhase;
}

export class WorkerStageDto extends WorkerProjectDto {
  @IsIn([...EFFECT_PROMPT_STAGE_STATUSES]) status!: EffectPromptStageStatus;
  @IsString() @MaxLength(500) summary = '';
  @IsArray() @IsString({ each: true }) @MaxLength(500, { each: true }) warnings: string[] = [];
  @Allow() metadata: unknown = {};
}

export class WorkerShardDto extends WorkerProjectDto {
  @IsOptional() @IsIn([...EFFECT_PROMPT_SHARD_PHASES]) phase?: EffectPromptShardPhase;
  @IsIn([...EFFECT_PROMPT_STAGE_STATUSES]) status!: EffectPromptStageStatus;
  @Allow() combinationPlan: unknown = [];
  @Allow() items: unknown = [];
  @Allow() blueprintPlan: unknown = [];
  @Allow() blueprints: unknown = [];
  @Allow() creativePlan: unknown = [];
  @Allow() creativeItems: unknown = [];
  @Allow() classificationPlan: unknown = [];
  @Allow() evaluations: unknown = [];
  @IsArray() @IsString({ each: true }) @MaxLength(500, { each: true }) warnings: string[] = [];
  @IsOptional() @IsString() @MaxLength(120) errorCode?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) errorMessage?: string | null;
}

export class WorkerCompleteDto extends WorkerProjectDto {
  @Allow() result!: EffectPromptBatchResult;
  @IsIn(['ARK', 'MOCK']) executionMode!: 'ARK' | 'MOCK';
}

export class WorkerFailDto extends WorkerProjectDto {
  @IsString() @MaxLength(120) errorCode!: string;
  @IsString() @MaxLength(1000) errorMessage!: string;
  @IsBoolean() retryable!: boolean;
  @IsArray() @IsString({ each: true }) @MaxLength(500, { each: true }) warnings: string[] = [];
  @IsOptional() @IsIn(EFFECT_PROMPT_GRAPH_NODES.map(({ id }) => id)) currentNode?: string | null;
}
