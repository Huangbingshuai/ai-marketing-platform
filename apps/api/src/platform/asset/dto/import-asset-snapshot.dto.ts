import {
  ASSET_WORKFLOWS,
  ASSET_WORKFLOW_SPACES,
  type ImportAssetSnapshotRequest,
} from '@ai-marketing/contracts';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class ImportAssetSnapshotDto implements ImportAssetSnapshotRequest {
  @IsUUID('4') sourceProjectId!: string;
  @IsUUID('4') sourceAssetId!: string;
  @IsOptional() @IsInt() @Min(1) sourceVersion?: number;
  @IsIn([...ASSET_WORKFLOWS]) targetWorkflow!: ImportAssetSnapshotRequest['targetWorkflow'];
  @IsIn([...ASSET_WORKFLOW_SPACES]) targetSpace!: ImportAssetSnapshotRequest['targetSpace'];
  @IsOptional() @IsString() @MaxLength(255) usageNode?: string;
}
