import { BadRequestException } from '@nestjs/common';
import { open } from 'node:fs/promises';

export async function wavDuration(path: string, size: number): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, 65_536));
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
      throw new BadRequestException('包装音频必须为 PCM WAV');
    let bytesPerSecond = 0;
    for (let pos = 12; pos + 8 <= buffer.length;) {
      const name = buffer.toString('ascii', pos, pos + 4),
        length = buffer.readUInt32LE(pos + 4);
      if (name === 'fmt ' && length >= 16 && pos + 24 <= buffer.length) {
        if (
          buffer.readUInt16LE(pos + 8) !== 1 ||
          buffer.readUInt16LE(pos + 10) !== 1 ||
          buffer.readUInt32LE(pos + 12) !== 24_000 ||
          buffer.readUInt16LE(pos + 20) !== 2 ||
          buffer.readUInt16LE(pos + 22) !== 16
        )
          throw new BadRequestException('包装音频编码无效');
        bytesPerSecond = buffer.readUInt32LE(pos + 16);
      }
      if (
        name === 'data' &&
        bytesPerSecond === 48_000 &&
        length > 0 &&
        length % 2 === 0 &&
        pos + 8 + length <= size
      )
        return length / bytesPerSecond;
      pos += 8 + length + (length % 2);
    }
    throw new BadRequestException('包装音频头或真实时长无效');
  } finally {
    await handle.close();
  }
}

export function parseVoiceSegmentFrames(
  value: string | undefined,
  duration: number,
): number[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.length ||
      parsed.length > 500 ||
      parsed.some((frames: unknown) => !Number.isSafeInteger(frames) || Number(frames) <= 0) ||
      Math.abs(
        parsed.reduce<number>((sum, frames: number) => sum + frames, 0) / 24_000 - duration,
      ) > 0.001
    )
      throw new Error('invalid segments');
    return parsed as number[];
  } catch {
    throw new BadRequestException('口播片段边界与音频不一致');
  }
}
