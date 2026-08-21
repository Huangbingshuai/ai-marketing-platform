import type { ApiErrorCode } from '@ai-marketing/contracts';
import { HttpException } from '@nestjs/common';

export class ApiHttpException extends HttpException {
  constructor(message: string, status: number, code: ApiErrorCode) {
    super({ message, code }, status);
  }
}
