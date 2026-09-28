import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpExceptionFilter } from './http-exception.filter';

const hostFor = () => {
  const response = {
    getHeader: vi.fn().mockReturnValue(undefined),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  return { host: { switchToHttp: () => ({ getResponse: () => response }) }, response };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpExceptionFilter', () => {
  it('answers a thrown HttpException with its own status and message', () => {
    const { host, response } = hostFor();

    new HttpExceptionFilter().catch(new ConflictException('校验提交遇到并发写入，请稍后重试'), host as never);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: '校验提交遇到并发写入，请稍后重试' }),
    );
  });

  it('logs the stack of an unexpected error instead of leaving the 500 unexplained', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, response } = hostFor();

    new HttpExceptionFilter().catch(new Error('boom'), host as never);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: '服务器内部错误', code: 'INTERNAL_ERROR' }),
    );
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('does not log an error it already reports to the caller', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host } = hostFor();

    new HttpExceptionFilter().catch(new ConflictException('已处理的冲突'), host as never);

    expect(logged).not.toHaveBeenCalled();
  });
});
