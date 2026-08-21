import { ASSET_DIRECTORIES, ASSET_STATUSES, ASSET_TYPES } from '@ai-marketing/contracts';
import { ArrayMaxSize, IsArray, IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UpdateAssetDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(120)
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn([...ASSET_DIRECTORIES])
  directory?: (typeof ASSET_DIRECTORIES)[number];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn([...ASSET_TYPES])
  type?: (typeof ASSET_TYPES)[number];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn([...ASSET_STATUSES])
  status?: (typeof ASSET_STATUSES)[number];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn([...ASSET_STATUSES])
  qualityStatus?: (typeof ASSET_STATUSES)[number];
}
