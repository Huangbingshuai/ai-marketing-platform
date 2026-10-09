import {
  Allow,
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
import {
  CUSTOMIZED_EXTRACTION_NODES,
  type CustomizedBrief,
  type CustomizedBriefCandidate,
} from '@ai-marketing/contracts';
export class ExtractionScopeDto {
  @IsUUID('4') workflowRunId!: string;
}
export class StartCustomizedExtractionDto extends ExtractionScopeDto {
  @IsUUID('4') sourceArtifactId!: string;
  @IsInt() @Min(1) sourceRevision!: number;
  @IsString() @MaxLength(500) idempotencyKey!: string;
}
export class ConfirmCustomizedExtractionDto {
  @IsInt() @Min(1) expectedRevision!: number;
}
export class UpdateCustomizedExtractionDto extends ConfirmCustomizedExtractionDto {
  @Allow() fields!: CustomizedBrief;
  @IsArray() @IsString({ each: true }) resolvedIssueIds!: string[];
}
export class WorkerProjectDto {
  @IsUUID('4') projectId!: string;
}
export class WorkerProgressDto extends WorkerProjectDto {
  @IsInt() @Min(0) @Max(99) progress!: number;
  @IsIn(CUSTOMIZED_EXTRACTION_NODES.map((n) => n.id)) nodeId!: string;
}
export class WorkerStepDto extends WorkerProjectDto {
  @IsIn(CUSTOMIZED_EXTRACTION_NODES.map((n) => n.id)) nodeId!: string;
  @IsString() @MaxLength(255) sourceId!: string;
  @IsIn(['PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED']) status!: string;
  @Allow() output!: unknown;
  @IsOptional() @IsString() @MaxLength(1000) errorMessage?: string;
}
export class WorkerCompleteDto extends WorkerProjectDto {
  @Allow() candidate!: CustomizedBriefCandidate;
}
export class WorkerFailDto extends WorkerProjectDto {
  @IsBoolean() partial!: boolean;
}
export class WorkerArtifactDto extends WorkerProjectDto {
  @IsUUID('4') sourceId!: string;
}
