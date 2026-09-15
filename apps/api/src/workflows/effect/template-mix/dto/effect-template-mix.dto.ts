import { Type } from 'class-transformer';
import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiTrim,
} from '@ai-marketing/contracts';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class EffectTemplateMixWorkspaceQueryDto {
  @IsUUID('4') workflowRunId!: string;
}

export class SaveEffectTemplateMixDraftDto {
  @IsUUID('4') workflowRunId!: string;
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number | null;
  @IsObject() draft!: Record<string, unknown>;
}

export class EffectTemplateMixRevisionDto {
  @IsUUID('4') workflowRunId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}

export class ApplyEffectTemplateMixVariantDto extends EffectTemplateMixRevisionDto {
  @IsUUID('4') sourceVariantId!: string;
  @IsBoolean() syncOtherVariants!: boolean;
}

export class ValidateEffectTemplateMixDto extends EffectTemplateMixRevisionDto {
  @IsUUID('4') templateId!: string;
}

export class CreateEffectTemplateMixAiRunDto extends EffectTemplateMixRevisionDto {
  @IsString() @MaxLength(500) idempotencyKey!: string;
  @IsOptional() @IsUUID('4') targetVariantId?: string;
}

export class EffectTemplateMixWorkerProjectDto {
  @IsUUID('4') projectId!: string;
}

export class EffectTemplateMixWorkerProgressDto extends EffectTemplateMixWorkerProjectDto {
  @IsIn(['CLASSIFYING', 'MATCHING', 'SAMPLING', 'TRIMMING'])
  stage!: 'CLASSIFYING' | 'MATCHING' | 'SAMPLING' | 'TRIMMING';
  @Type(() => Number) @IsInt() @Min(1) @Max(95) progress!: number;
}

export class EffectTemplateMixWorkerClassificationDto extends EffectTemplateMixWorkerProjectDto {
  @IsArray() classifications!: EffectTemplateMixAiClassification[];
}

export class EffectTemplateMixWorkerCompleteDto extends EffectTemplateMixWorkerProjectDto {
  @IsArray() trims!: EffectTemplateMixAiTrim[];
}

export class EffectTemplateMixWorkerFailDto extends EffectTemplateMixWorkerProjectDto {
  @IsString() @MaxLength(120) errorCode!: string;
  @IsString() @MaxLength(1000) errorMessage!: string;
  @IsBoolean() retryable!: boolean;
}
