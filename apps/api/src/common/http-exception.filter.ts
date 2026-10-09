import type { ApiErrorCode, ApiErrorResponse } from '@ai-marketing/contracts';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
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

const isDeletedTemplateWrite = (exception: unknown): boolean =>
  exception instanceof Error && exception.message.includes('EFFECT_TEMPLATE_DELETED');

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : isDeletedTemplateWrite(exception)
          ? HttpStatus.CONFLICT
        : isFileTooLarge(exception)
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.INTERNAL_SERVER_ERROR;
    const code = isDeletedTemplateWrite(exception) ? 'VALIDATION_ERROR' : exceptionCode(exception);
    const message =
      isDeletedTemplateWrite(exception)
        ? '此混剪模板已删除，请返回模板列表继续操作'
      : code === 'FILE_TOO_LARGE'
        ? '文件大小超过上传限制'
        : exception instanceof HttpException
          ? exceptionMessage(exception)
          : '服务器内部错误';
    const requestIdHeader = response.getHeader('x-request-id');
    const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
    // This filter takes over from Nest's own handler, which is the thing that normally prints unhandled
    // stacks. Without this line an unexpected 500 leaves no trace anywhere — the response body says only
    // "服务器内部错误", so there is nothing to debug with. Log the stack; keep the body as it is.
    if (!(exception instanceof HttpException) && !isDeletedTemplateWrite(exception))
      logger.error(
        `[${String(requestId)}] ${exception instanceof Error ? exception.stack : String(exception)}`,
      );

    response.status(status).json({
      success: false,
      data: null,
      message,
      code,
      ...(requestId === undefined ? {} : { requestId: String(requestId) }),
    });
  }
}

const logger = new Logger(HttpExceptionFilter.name);
