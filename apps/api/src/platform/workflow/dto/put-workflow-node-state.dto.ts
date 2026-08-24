import { IsDefined, IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

export class PutWorkflowNodeStateDto {
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  expectedRevision!: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  schemaVersion?: number;

  @IsDefined()
  state!: unknown;
}
