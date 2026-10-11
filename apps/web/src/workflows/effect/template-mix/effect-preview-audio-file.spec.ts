import { describe, expect, it, vi } from 'vitest';
import { readPreviewAudioFile } from './effect-preview-audio-file';

describe('existing preview audio file recovery', () => {
  it('recovers a transient API failure without replaying a generation request', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
    const delay = vi.fn(async () => undefined);
    expect((await readPreviewAudioFile('/file/content', request, delay)).byteLength).toBe(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
    expect(delay).toHaveBeenCalledWith(250);
  });
  it('bounds network retries and preserves the failure', async () => {
    const request = vi.fn().mockRejectedValue(new TypeError('network failed'));
    const delay = vi.fn(async () => undefined);
    await expect(readPreviewAudioFile('/file/content', request, delay)).rejects.toThrow('network failed');
    expect(request).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls).toEqual([[250], [500]]);
  });
  it.each([401, 403, 404, 410])('does not retry permanent status %s', async status => {
    const request = vi.fn().mockResolvedValue(new Response('', { status }));
    const delay = vi.fn(async () => undefined);
    await expect(readPreviewAudioFile('/file/content', request, delay)).rejects.toThrow('文件读取失败');
    expect(request).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });
  it('recovers a disconnected response body', async () => {
    const broken = new Response();
    vi.spyOn(broken, 'arrayBuffer').mockRejectedValue(new TypeError('connection closed'));
    const request = vi.fn().mockResolvedValueOnce(broken).mockResolvedValueOnce(new Response('audio'));
    expect((await readPreviewAudioFile('/file/content', request, async () => undefined)).byteLength).toBe(5);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not keep retrying capacity errors', async () => {
    const request = vi.fn().mockResolvedValue(new Response('', { headers: { 'content-length': String(101 * 1024 * 1024) } }));
    await expect(readPreviewAudioFile('/file/content', request)).rejects.toThrow('预览容量');
    expect(request).toHaveBeenCalledOnce();
  });
});
