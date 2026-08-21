import {
  ASSET_TYPES,
  ASSET_WORKFLOWS,
  ASSET_WORKFLOW_SPACES,
  type ImportAssetsMetadata,
} from '@ai-marketing/contracts';
import { IsIn } from 'class-validator';

export class ImportAssetsDto implements ImportAssetsMetadata {
  @IsIn([...ASSET_WORKFLOWS]) workflow!: ImportAssetsMetadata['workflow'];
  @IsIn([...ASSET_WORKFLOW_SPACES]) space!: ImportAssetsMetadata['space'];
  @IsIn([...ASSET_TYPES]) type!: ImportAssetsMetadata['type'];
}
