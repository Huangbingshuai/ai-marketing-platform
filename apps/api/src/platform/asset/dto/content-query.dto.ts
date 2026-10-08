import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ContentQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  download?: 'true' | 'false';

  /** Read-only browser cache markers used by the shared image preview components. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  preview?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  view?: string;
}
