import { Type } from 'class-transformer';
import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixSamplingCheckpoint,
  EffectTemplateMixAiTrim,
  EffectTemplateMixSampledMaterial,
} from '@ai-marketing/contracts';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
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

export class EffectTemplateMixWorkerSampledMaterialDto implements EffectTemplateMixSampledMaterial {
  @IsUUID('4') materialId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @Type(() => Number)
  @IsNumber({}, { each: true }) frameTimestampsSeconds!: number[];
}

export class EffectTemplateMixWorkerSamplingDto extends EffectTemplateMixWorkerProjectDto {
  /** Current worker payload, with the actual source times of extracted frames. */
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true })
  @Type(() => EffectTemplateMixWorkerSampledMaterialDto)
  samples?: EffectTemplateMixSamplingCheckpoint['samples'];
  /** Legacy rolling-deploy payload; new workers must send samples instead. */
  @IsOptional() @IsArray() @IsUUID('4', { each: true })
  materialIds?: EffectTemplateMixSamplingCheckpoint['materialIds'];
}

export class EffectTemplateMixWorkerCompleteDto extends EffectTemplateMixWorkerProjectDto {
  @IsArray() trims!: EffectTemplateMixAiTrim[];
}

export class EffectTemplateMixWorkerFailDto extends EffectTemplateMixWorkerProjectDto {
  @IsString() @MaxLength(120) errorCode!: string;
  @IsString() @MaxLength(1000) errorMessage!: string;
  @IsBoolean() retryable!: boolean;
}
