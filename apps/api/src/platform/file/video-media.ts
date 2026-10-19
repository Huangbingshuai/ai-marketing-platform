import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// ffprobe reports the same demuxer name for Matroska and WebM. Verify the EBML
// DocType too, so renaming an MKV does not bypass the supported-format contract.
async function isWebM(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 5 || buffer.readUInt32BE(0) !== 0x1a45dfa3) return false;
    const variable = (offset: number, size: boolean) => {
      let length = 1,
        flag = 0x80;
      while (length <= 8 && !(buffer[offset]! & flag)) {
        length++;
        flag >>= 1;
      }
      if (length > 8 || offset + length > bytesRead) return null;
      let value = size ? buffer[offset]! & (flag - 1) : buffer[offset]!;
      for (let index = 1; index < length; index++) value = value * 256 + buffer[offset + index]!;
      return { length, value };
    };
    const header = variable(4, true);
    if (!header) return false;
    const end = 4 + header.length + header.value;
    if (end > bytesRead) return false;
    let offset = 4 + header.length;
    while (offset < end) {
      const id = variable(offset, false);
      if (!id) return false;
      offset += id.length;
      const size = variable(offset, true);
      if (!size) return false;
      offset += size.length;
      if (offset + size.value > end) return false;
      if (id.value === 0x4282)
        return buffer.toString('ascii', offset, offset + size.value) === 'webm';
      offset += size.value;
    }
    return false;
  } finally {
    await file.close();
  }
}
export type ImportVideoMetadata = {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number | null;
  mimeType: string;
};

export function parseImportVideoMetadata(
  value: unknown,
  fileName: string,
  limits = { minSeconds: 4, maxSeconds: 30 },
): ImportVideoMetadata {
  const probe = value as {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
      tags?: { DURATION?: string };
      disposition?: { attached_pic?: number };
    }>;
  };
  const extension = extname(fileName).toLowerCase();
  const formats = probe?.format?.format_name?.split(',') ?? [];
  const supported = ['.mp4', '.mov'].includes(extension)
    ? formats.some((format) => ['mov', 'mp4'].includes(format))
    : extension === '.webm' && formats.includes('webm');
  if (!supported) throw new Error('视频实际格式与扩展名不符，仅支持 MP4、MOV、WebM');
  const video = probe.streams?.find(
    (stream) =>
      stream.codec_type === 'video' &&
      !stream.disposition?.attached_pic &&
      (stream.width ?? 0) > 0 &&
      (stream.height ?? 0) > 0,
  );
  if (!video) throw new Error('文件中没有有效视频画面');
  const tagParts = video.tags?.DURATION?.split(':').map(Number);
  const taggedDuration =
    tagParts?.length === 3 && tagParts.every(Number.isFinite)
      ? tagParts[0]! * 3600 + tagParts[1]! * 60 + tagParts[2]!
      : NaN;
  const videoDuration = Number.isFinite(Number(video.duration))
    ? Number(video.duration)
    : taggedDuration;
  const containerDuration = Number(probe.format?.duration);
  // A longer audio stream must never make the picture appear long enough for a slot.
  if (
    !Number.isFinite(videoDuration) &&
    probe.streams?.some((stream) => stream.codec_type === 'audio')
  )
    throw new Error('无法确定视频画面的实际时长，请转换为标准 MP4 后导入');
  const durationSeconds = Number.isFinite(videoDuration) ? videoDuration : containerDuration;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < limits.minSeconds ||
    durationSeconds > limits.maxSeconds ||
    (Number.isFinite(containerDuration) && containerDuration > limits.maxSeconds)
  )
    throw new Error(`视频时长必须在 ${limits.minSeconds}～${limits.maxSeconds} 秒之间`);
  return {
    durationSeconds,
    width: video.width!,
    height: video.height!,
    frameRate: parseAverageFrameRate(video.avg_frame_rate),
    mimeType:
      extension === '.webm' ? 'video/webm' : extension === '.mov' ? 'video/quicktime' : 'video/mp4',
  };
}

/** ffprobe reports rational average rates, including 0/0 for unavailable metadata. */
function parseAverageFrameRate(value: string | undefined): number | null {
  if (!value || !/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/u.test(value)) return null;
  const [numerator, denominator = '1'] = value.split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export async function inspectImportVideo(
  path: string,
  fileName: string,
  limits = { minSeconds: 4, maxSeconds: 30 },
): Promise<ImportVideoMetadata> {
  if (extname(fileName).toLowerCase() === '.webm' && !(await isWebM(path)))
    throw new Error('视频实际格式与扩展名不符，仅支持 MP4、MOV、WebM');
  let stdout: string;
  try {
    ({ stdout } = await execute(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-show_entries',
        'format=format_name,duration:stream=codec_type,width,height,duration,avg_frame_rate:stream_disposition=attached_pic:stream_tags=DURATION',
        '-of',
        'json',
        path,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
    ));
  } catch {
    throw new Error('无法读取视频，请检查文件是否损坏或视频校验服务是否可用');
  }
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('无法解析视频信息，请检查文件是否损坏');
  }
  return parseImportVideoMetadata(data, fileName, limits);
}
