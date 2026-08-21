import { IsIn, IsOptional } from 'class-validator';

export class ContentQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  download?: 'true' | 'false';
}
