import { IsString, Length } from 'class-validator';

export class CreateEffectWorkflowBranchDto {
  @IsString()
  @Length(1, 80)
  idempotencyKey!: string;
}
