import {
  EFFECT_IMPORT_UPLOAD_MATERIAL_TYPES,
  EFFECT_IMPORT_MODES,
  type EffectImportMaterialType,
  type EffectImportMode,
  type EffectImportUploadMaterialType,
  type EffectVideoConfig,
  type EffectVideoConfigOverride,
} from '@ai-marketing/contracts';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ExpectedRevisionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedRevision?: number;
}

export class SwitchModeDto extends ExpectedRevisionDto {
  @IsIn([...EFFECT_IMPORT_MODES]) mode!: EffectImportMode;
}

export class UpdateDraftDto extends ExpectedRevisionDto {
  @Allow() globalConfig!: EffectVideoConfig;
}

export class ListProductsQueryDto {
  @IsOptional() @IsString() @MaxLength(160) keyword?: string;
  @IsOptional() @IsString() @MaxLength(120) category?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class CreateProductDto extends ExpectedRevisionDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(120) category?: string;
  @IsOptional() @IsString() @MaxLength(2000) commerceUrl?: string | null;
  @IsOptional() @Allow() configOverride?: EffectVideoConfigOverride;
}

export class UpdateProductDto extends ExpectedRevisionDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(120) category?: string;
  @IsOptional() @IsString() @MaxLength(2000) commerceUrl?: string | null;
  @IsOptional() @Allow() configOverride?: EffectVideoConfigOverride;
}

export class BatchProductsDto extends ExpectedRevisionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('4', { each: true }) productIds!: string[];
}

export class ValidateLinkDto {
  @IsString() @MaxLength(2000) commerceUrl!: string;
}

export class CreateMaterialDto extends ExpectedRevisionDto {
  @IsIn([...EFFECT_IMPORT_UPLOAD_MATERIAL_TYPES]) type!: EffectImportMaterialType;
  @IsOptional() @IsString() @MaxLength(255) expectedFileName?: string;
}

export class CreateUploadSessionDto extends ExpectedRevisionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @Allow() items!: Array<{
    clientFileId: string;
    type: EffectImportUploadMaterialType;
    originalFileName: string;
    mimeType: string;
    sizeBytes: number;
    expectedFileName?: string;
  }>;
}

export class CompleteUploadSessionDto {
  @IsString() @MaxLength(500) completionKey!: string;
}

export class PreviewManifestDto extends ExpectedRevisionDto {
  @IsOptional() @IsString() @MaxLength(500) idempotencyKey?: string;
}

export class CommitManifestDto extends ExpectedRevisionDto {
  @IsString() @MaxLength(500) idempotencyKey!: string;
}

export class ManifestTemplateQueryDto {
  @IsIn(['csv', 'xlsx']) format!: 'csv' | 'xlsx';
}
