import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { FinalOutputSourceTrim } from '@ai-marketing/contracts';
import { EffectTemplateMixWorkerProjectDto } from './effect-template-mix.dto';

export class SourceTrimDto implements FinalOutputSourceTrim {
  @IsString() @MaxLength(100) slotId!: string;
  @IsNumber() @Min(0) offset!: number;
}
export class SourceTrimsDto extends EffectTemplateMixWorkerProjectDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => SourceTrimDto)
  trims!: SourceTrimDto[];
}
