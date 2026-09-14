import { Type } from 'class-transformer';
import { IsInt, IsUUID, Min } from 'class-validator';

export class ValidateEffectTemplateMixDto {
  @IsUUID('4') workflowRunId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @IsUUID('4') templateId!: string;
}
