import {
  EFFECT_EXTRACTION_BRANCHES,
  EFFECT_EXTRACTION_BRANCH_STATUSES,
  type EffectExtractionBranch,
  type EffectExtractionBranchStatus,
  type EffectExtractionResult,
  type EffectExtractionWarning,
} from '@ai-marketing/contracts';
import { Type } from 'class-transformer';
import {
  Allow,
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

import {
  EFFECT_EXTRACTION_ARTIFACT_KINDS,
  type EffectExtractionArtifactKind,
} from '../effect-extraction.types';

export class ExtractionWorkspaceQueryDto {
  @IsUUID('4') draftId!: string;
}

export class StartExtractionRunDto {
  @IsUUID('4') draftId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @IsString() @MaxLength(500) idempotencyKey!: string;
}

export class UpdateExtractionResultDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @Allow() result!: EffectExtractionResult;
}

export class ValidateExtractionResultDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class WorkerProjectDto {
  @IsUUID('4') projectId!: string;
}

export class WorkerProgressDto extends WorkerProjectDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(99) progress!: number;
  @IsString() @MaxLength(120) currentNode!: string;
}

export class WorkerBranchOutputDto extends WorkerProjectDto {
  @IsIn([...EFFECT_EXTRACTION_BRANCHES]) branch!: EffectExtractionBranch;
  @IsIn([...EFFECT_EXTRACTION_BRANCH_STATUSES]) status!: EffectExtractionBranchStatus;
  @IsOptional() @Allow() structuredOutput?: unknown;
  @IsOptional() @IsString() @MaxLength(500) textStorageKey?: string | null;
  @Allow() warnings: EffectExtractionWarning[] = [];
  @IsOptional() @IsString() @MaxLength(120) errorCode?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) errorMessage?: string | null;
}

export class WorkerCompleteDto extends WorkerProjectDto {
  @Allow() result!: EffectExtractionResult;
  @Allow() provenance: unknown = {};
  @Allow() conflictReport: unknown = [];
  @Allow() warnings: EffectExtractionWarning[] = [];
}

export class WorkerFailDto extends WorkerProjectDto {
  @IsString() @MaxLength(120) errorCode!: string;
  @IsString() @MaxLength(1000) errorMessage!: string;
  @IsBoolean() retryable!: boolean;
  @Allow() warnings: EffectExtractionWarning[] = [];
}

export class WorkerArtifactDto extends WorkerProjectDto {
  @IsIn([...EFFECT_EXTRACTION_ARTIFACT_KINDS]) artifactKind!: EffectExtractionArtifactKind;
  @IsOptional() @IsString() @MaxLength(255) sourceId?: string;
  @IsString() @MaxLength(500) idempotencyKey!: string;
}
