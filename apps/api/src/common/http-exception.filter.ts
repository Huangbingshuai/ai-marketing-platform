import type { ApiErrorResponse } from '@ai-marketing/contracts';
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

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof HttpException ? exceptionMessage(exception) : '服务器内部错误';
    const requestIdHeader = response.getHeader('x-request-id');
    const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;

    response.status(status).json({
      success: false,
      data: null,
      message,
      ...(requestId === undefined ? {} : { requestId: String(requestId) }),
    });
  }
}
