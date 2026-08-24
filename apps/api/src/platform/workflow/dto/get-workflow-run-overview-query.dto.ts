import { ASSET_WORKFLOWS, ASSET_WORKFLOW_SPACES } from '@ai-marketing/contracts';
import { IsIn } from 'class-validator';

export class GetWorkflowRunOverviewQueryDto {
  @IsIn([...ASSET_WORKFLOWS])
  workflow!: (typeof ASSET_WORKFLOWS)[number];

  @IsIn([...ASSET_WORKFLOW_SPACES])
  space!: (typeof ASSET_WORKFLOW_SPACES)[number];
}
