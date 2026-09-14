import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsObject, IsUUID, Min, ValidateIf } from 'class-validator';

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
