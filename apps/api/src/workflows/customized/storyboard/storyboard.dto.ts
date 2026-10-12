import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  CustomizedStoryboardScript,
  StoryboardSettings,
  StoryboardStep,
} from '@ai-marketing/contracts';
export class StoryboardScopeDto {
  @IsUUID() workflowRunId!: string;
}
export class StoryboardSettingsDto implements StoryboardSettings {
  @IsInt() @Min(1) @Max(3600) targetDurationSeconds!: number;
  @IsInt() @Min(1) @Max(5) variantCount!: number;
  @IsIn(['AI', 'REFERENCE', 'CUSTOM']) structureMode!: StoryboardSettings['structureMode'];
  @IsString() @MaxLength(20000) structure!: string;
  @IsString() @MaxLength(20000) instructions!: string;
}
export class SaveStoryboardSettingsDto extends StoryboardScopeDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @ValidateNested() @Type(() => StoryboardSettingsDto) settings!: StoryboardSettingsDto;
  @IsOptional() @IsUUID() selectedScriptId?: string | null;
}
export class StartStoryboardDto extends StoryboardScopeDto {
  @IsInt() @Min(0) expectedRevision!: number;
  @IsString() @MaxLength(200) idempotencyKey!: string;
}
export class StoryboardDetailQueryDto {
  @IsOptional() @IsUUID() scriptId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) page = 0;
}
export class CreateScriptDto extends StoryboardScopeDto {
  @IsObject() script!: CustomizedStoryboardScript;
  @IsIn(['MANUAL', 'IMPORT']) origin!: 'MANUAL' | 'IMPORT';
}
export class EditScriptDto {
  @IsIn(['begin', 'draft', 'cancel', 'save', 'discard']) action!:
    'begin' | 'draft' | 'cancel' | 'save' | 'discard';
  @IsInt() @Min(1) expectedRevision!: number;
  @IsOptional() @IsObject() script?: CustomizedStoryboardScript;
}
export class StoryboardWorkerDto {
  @IsUUID() projectId!: string;
}
export class StoryboardStepDto extends StoryboardWorkerDto {
  @IsIn(['SNAPSHOT', 'CONCEPT', 'STORY', 'ASSETS', 'SHOTS', 'REVIEW', 'REPAIR'])
  nodeId!: StoryboardStep['nodeId'];
  @IsString() @MaxLength(40) scriptId!: string;
  @IsIn(['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED']) status!: StoryboardStep['status'];
  @IsOptional() output: unknown = null;
  @IsOptional() @IsString() @MaxLength(1000) errorMessage: string | null = null;
}
export class PublishScriptDto extends StoryboardWorkerDto {
  @IsObject() script!: CustomizedStoryboardScript;
}
