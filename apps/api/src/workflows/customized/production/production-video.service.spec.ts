import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { ProductionVideoService } from './production-video.service';
it('serves a scoped byte range with full-file size and download headers', async () => {
  const projects = { get: vi.fn().mockResolvedValue({}) };
  const repository = {
    videoFile: vi.fn().mockResolvedValue({
      storageKey: 'controlled-key',
      sizeBytes: 8,
      mimeType: 'video/mp4',
      originalFileName: '杯.mp4',
    }),
  };
  const storage = {
    open: vi.fn().mockResolvedValue({
      stream: Readable.from(Buffer.from('vi')),
      sizeBytes: 8,
      start: 2,
      end: 3,
      contentLength: 2,
    }),
  };
  const response = { setHeader: vi.fn(), statusCode: 200 };
  const service = new ProductionVideoService(
    repository as never,
    storage as never,
    projects as never,
  );
  const result = await service.content(
    'p',
    'r',
    'clip',
    false,
    'bytes=2-3',
    true,
    response as unknown as ServerResponse,
  );
  expect(projects.get).toHaveBeenCalledWith('p');
  expect(repository.videoFile).toHaveBeenCalledWith('p', 'r', 'clip', false);
  expect(storage.open).toHaveBeenCalledWith('controlled-key', { start: 2, end: 3 });
  expect(response.statusCode).toBe(206);
  expect(response.setHeader).toHaveBeenCalledWith('content-range', 'bytes 2-3/8');
  expect(result.getHeaders()).toMatchObject({ type: 'video/mp4', length: 2 });
  expect(response.setHeader).toHaveBeenCalledWith(
    'content-disposition',
    expect.stringContaining('attachment; filename*=UTF-8'),
  );
});
it('refuses file access before touching storage when project authorization fails', async () => {
  const projects = { get: vi.fn().mockRejectedValue(new Error('denied')) },
    repository = { videoFile: vi.fn() },
    storage = { open: vi.fn() };
  const service = new ProductionVideoService(
    repository as never,
    storage as never,
    projects as never,
  );
  await expect(
    service.content('other', 'r', 'clip', false, undefined, false, {} as ServerResponse),
  ).rejects.toThrow('denied');
  expect(repository.videoFile).not.toHaveBeenCalled();
  expect(storage.open).not.toHaveBeenCalled();
});
