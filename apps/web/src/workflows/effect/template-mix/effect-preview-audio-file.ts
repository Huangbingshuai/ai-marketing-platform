/** Retrying an existing file is read-only; never replay a generation request here. */
export async function readPreviewAudioFile(
  url: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  delay: (milliseconds: number) => Promise<void> = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await request(url, { signal: AbortSignal.timeout(12_000) });
    } catch (error) {
      const retryable = error instanceof TypeError ||
        (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
      if (!retryable || attempt >= 2) throw error;
      await delay(250 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      if (attempt < 2 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        await delay(250 * (attempt + 1));
        continue;
      }
      throw new Error('口播或配乐文件读取失败，请稍后重新播放');
    }
    if (Number(response.headers.get('content-length')) > 100 * 1024 * 1024)
      throw new Error('音频超过预览容量');
    // A disconnected response body is also a safe GET retry, not a new TTS request.
    try {
      const content = await response.arrayBuffer();
      if (content.byteLength > 100 * 1024 * 1024) throw new Error('音频超过预览容量');
      return content;
    } catch (error) {
      const retryable = error instanceof TypeError ||
        (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
      if (!retryable || attempt >= 2) throw error;
      await delay(250 * (attempt + 1));
    }
  }
}
