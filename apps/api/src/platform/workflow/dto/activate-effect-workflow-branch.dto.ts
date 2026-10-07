import type { ActivateEffectWorkflowBranchRequest } from '@ai-marketing/contracts';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ActivateEffectWorkflowBranchDto implements ActivateEffectWorkflowBranchRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  templateId?: string | null;
}
