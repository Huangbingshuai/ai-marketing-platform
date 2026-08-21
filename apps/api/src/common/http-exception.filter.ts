import type { ApiErrorCode, ApiErrorResponse } from '@ai-marketing/contracts';
import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';

type HttpResponse = {
  getHeader(name: string): number | string | string[] | undefined;
  status(code: number): HttpResponse;
  json(body: ApiErrorResponse): void;
};

const exceptionMessage = (exception: HttpException): string => {
  const response = exception.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  const message = 'message' in response ? response.message : undefined;
  return Array.isArray(message) ? message.join('; ') : String(message ?? exception.message);
};

const exceptionCode = (exception: unknown): ApiErrorCode => {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const code = body.code;
      if (typeof code === 'string') return code as ApiErrorCode;
    }
    if (exception.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE) return 'FILE_TOO_LARGE';
  }

  if (
    typeof exception === 'object' &&
    exception !== null &&
    'code' in exception &&
    exception.code === 'LIMIT_FILE_SIZE'
  ) {
    return 'FILE_TOO_LARGE';
  }

  return exception instanceof HttpException ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
};

const isFileTooLarge = (exception: unknown): boolean =>
  typeof exception === 'object' &&
  exception !== null &&
  'code' in exception &&
  exception.code === 'LIMIT_FILE_SIZE';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : isFileTooLarge(exception)
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = exceptionCode(exception);
    const message =
      code === 'FILE_TOO_LARGE'
        ? '文件大小超过上传限制'
        : exception instanceof HttpException
          ? exceptionMessage(exception)
          : '服务器内部错误';
    const requestIdHeader = response.getHeader('x-request-id');
    const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;

    response.status(status).json({
      success: false,
      data: null,
      message,
      code,
      ...(requestId === undefined ? {} : { requestId: String(requestId) }),
    });
  }
}
