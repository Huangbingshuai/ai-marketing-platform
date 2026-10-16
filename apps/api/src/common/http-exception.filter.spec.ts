import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpExceptionFilter } from './http-exception.filter';

const hostFor = () => {
  const response = {
    getHeader: vi.fn().mockReturnValue(undefined),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    destroy: vi.fn(),
  };
  return { host: { switchToHttp: () => ({ getResponse: () => response }) }, response };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HttpExceptionFilter', () => {
  it.each(['headersSent', 'writableEnded', 'destroyed'] as const)(
    'does not write a second response after a stream is %s', (state) => {
      const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { host, response } = hostFor();
      Object.assign(response, { [state]: true });
      new HttpExceptionFilter().catch(new Error('stream closed'), host as never);
      expect(response.status).not.toHaveBeenCalled();
      expect(response.json).not.toHaveBeenCalled();
      expect(logged).not.toHaveBeenCalled();
      expect(response.destroy).toHaveBeenCalledTimes(state === 'headersSent' ? 1 : 0);
    },
  );
  it('classifies parser overflow without logging the submitted content', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, response } = hostFor();
    new HttpExceptionFilter().catch(
      Object.assign(new Error('private submitted content'), {
        type: 'entity.too.large',
        status: 413,
      }),
      host as never,
    );
    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'FILE_TOO_LARGE',
        message: '保存内容超过接口大小限制，请减少本次提交内容',
      }),
    );
    expect(logged).not.toHaveBeenCalled();
  });
  it('reports deleted-template late writes as a safe conflict, without logging raw database data', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { host, response } = hostFor();
    new HttpExceptionFilter().catch(
      new Error('driver message EFFECT_TEMPLATE_DELETED'),
      host as never,
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: '此混剪模板已删除，请返回模板列表继续操作',
      }),
    );
    expect(logged).not.toHaveBeenCalled();
  });
  it('answers a thrown HttpException with its own status and message', () => {
    const { host, response } = hostFor();

    new HttpExceptionFilter().catch(
      new ConflictException('校验提交遇到并发写入，请稍后重试'),
      host as never,
    );

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
