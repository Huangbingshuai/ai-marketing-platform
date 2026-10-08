import type { SaveCustomizedSourceVersionRequest } from '@ai-marketing/contracts';
import { IsInt, Min } from 'class-validator';

export class SaveCustomizedSourceVersionDto implements SaveCustomizedSourceVersionRequest {
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}
