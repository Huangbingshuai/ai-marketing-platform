import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wavDuration } from './effect-packaging-audio';

describe('packaging music PCM format boundary', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'packaging-music-pcm-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const wav = (channels: number, rate: number) => {
    const header = Buffer.alloc(44),
      align = channels * 2,
      length = rate * align;
    header.write('RIFF');
    header.writeUInt32LE(36 + length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(length, 28);
    header.writeUInt16LE(align, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(length, 40);
    return Buffer.concat([header, Buffer.alloc(length)]);
  };
  it.each([
    [1, 24000],
    [2, 48000],
  ])('accepts legacy and stereo music (%s/%s)', async (channels, rate) => {
    const data = wav(channels!, rate!),
      path = join(directory, `music-${channels}.wav`);
    await writeFile(path, data);
    expect(await wavDuration(path, data.length, 'MUSIC')).toBe(1);
    if (channels === 2) await expect(wavDuration(path, data.length)).rejects.toThrow('编码无效');
    else expect(await wavDuration(path, data.length)).toBe(1);
  });
  it('rejects forged byte rate and truncated stereo payload', async () => {
    const data = wav(2, 48000),
      path = join(directory, 'invalid.wav');
    data.writeUInt32LE(48000, 28);
    await writeFile(path, data);
    await expect(wavDuration(path, data.length, 'MUSIC')).rejects.toThrow('编码无效');
    const valid = wav(2, 48000);
    await writeFile(path, valid.subarray(0, valid.length - 1));
    await expect(wavDuration(path, valid.length - 1, 'MUSIC')).rejects.toThrow('文件时长无效');
  });
});
