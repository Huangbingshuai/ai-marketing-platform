import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inspectImportVideo } from './effect-segment-import-media';

it.skipIf(process.env.EFFECT_IMPORT_MEDIA_TEST !== '1')(
  'validates actual ffprobe output and rejects an MKV disguised as WebM',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'effect-import-media-test-'));
    try {
      for (const seconds of [3, 4, 30, 31]) {
        const path = join(directory, `${seconds}.mp4`);
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=blue:s=16x16:r=1',
            '-t',
            String(seconds),
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-y',
            path,
          ],
          { timeout: 10_000, windowsHide: true },
        );
        if (seconds === 4 || seconds === 30)
          expect((await inspectImportVideo(path, `${seconds}.mp4`)).durationSeconds).toBe(seconds);
        else await expect(inspectImportVideo(path, `${seconds}.mp4`)).rejects.toThrow('4～30');
      }
      const matroska = join(directory, 'actual.mkv'),
        renamed = join(directory, 'renamed.webm');
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          join(directory, '4.mp4'),
          '-c',
          'copy',
          '-y',
          matroska,
        ],
        { timeout: 10_000, windowsHide: true },
      );
      await copyFile(matroska, renamed);
      await expect(inspectImportVideo(renamed, 'renamed.webm')).rejects.toThrow('实际格式');
      const webm = join(directory, 'actual.webm');
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          join(directory, '4.mp4'),
          '-c:v',
          'libvpx-vp9',
          '-y',
          webm,
        ],
        { timeout: 10_000, windowsHide: true },
      );
      expect(await inspectImportVideo(webm, 'actual.webm')).toMatchObject({
        durationSeconds: 4,
        mimeType: 'video/webm',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
