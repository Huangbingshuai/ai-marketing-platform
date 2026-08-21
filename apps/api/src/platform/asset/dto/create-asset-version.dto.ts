import type { CreateAssetVersionRequest } from '@ai-marketing/contracts';
import { ASSET_STATUSES } from '@ai-marketing/contracts';
import { Allow, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateAssetVersionDto implements CreateAssetVersionRequest {
  @IsString() @Matches(/\S/) @MaxLength(2000) changeNote!: string;
  @IsOptional() @IsIn([...ASSET_STATUSES]) status?: CreateAssetVersionRequest['status'];
  @IsOptional()
  @IsIn([...ASSET_STATUSES])
  qualityStatus?: CreateAssetVersionRequest['qualityStatus'];
  @IsOptional() @Allow() content?: unknown;
  @IsOptional() @Allow() businessData?: unknown;
}
