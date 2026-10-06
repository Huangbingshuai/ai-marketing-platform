import { describe, expect, it } from 'vitest';
import { parseImportVideoMetadata } from './effect-segment-import-media';

const probe = (duration: string, format = 'mov,mp4,m4a,3gp,3g2,mj2') => ({
  format: { format_name: format, duration },
  streams: [{ codec_type: 'video', width: 720, height: 1280, duration }],
});
describe('actual imported video validation', () => {
  it('uses picture duration, never a longer audio/container duration for slot matching', () => {
    expect(
      parseImportVideoMetadata(
        { ...probe('10'), format: { format_name: 'mp4', duration: '20' } },
        'video.mp4',
      ).durationSeconds,
    ).toBe(10);
    expect(() =>
      parseImportVideoMetadata(
        { ...probe('3'), format: { format_name: 'mp4', duration: '10' } },
        'video.mp4',
      ),
    ).toThrow('4～30');
    expect(
      parseImportVideoMetadata(
        {
          format: { format_name: 'matroska,webm', duration: '20' },
          streams: [
            {
              codec_type: 'video',
              width: 1280,
              height: 720,
              tags: { DURATION: '00:00:08.250000000' },
            },
            { codec_type: 'audio' },
          ],
        },
        'video.webm',
      ).durationSeconds,
    ).toBe(8.25);
  });
  it.each(['4', '4.25', '30'])('accepts %s seconds including both bounds', (duration) => {
    expect(parseImportVideoMetadata(probe(duration), 'upload.mp4').durationSeconds).toBe(
      Number(duration),
    );
  });
  it.each(['3.99', '30.01', '0', '-4', 'NaN', 'Infinity'])(
    'rejects invalid duration %s',
    (duration) => {
      expect(() => parseImportVideoMetadata(probe(duration), 'upload.mp4')).toThrow('4～30');
    },
  );
  it('validates actual container rather than trusting MIME or extension', () => {
    expect(() => parseImportVideoMetadata(probe('10', 'mp3'), 'spoofed.mp4')).toThrow('实际格式');
    expect(() => parseImportVideoMetadata(probe('10'), 'spoofed.webm')).toThrow('实际格式');
    expect(parseImportVideoMetadata(probe('10', 'matroska,webm'), 'upload.webm').mimeType).toBe(
      'video/webm',
    );
    expect(parseImportVideoMetadata(probe('10'), 'upload.MOV').mimeType).toBe('video/quicktime');
  });
  it('rejects audio-only media and an album cover masquerading as a video', () => {
    expect(() =>
      parseImportVideoMetadata({ ...probe('10'), streams: [{ codec_type: 'audio' }] }, 'audio.mp4'),
    ).toThrow('没有有效视频');
    expect(() =>
      parseImportVideoMetadata(
        {
          ...probe('10'),
          streams: [{ ...probe('10').streams[0], disposition: { attached_pic: 1 } }],
        },
        'cover.mp4',
      ),
    ).toThrow('没有有效视频');
  });
  it('does not mistake a short video stream plus a longer container for a valid short clip', () => {
    expect(() =>
      parseImportVideoMetadata(
        { ...probe('10'), format: { format_name: 'mp4', duration: '45' } },
        'video.mp4',
      ),
    ).toThrow('4～30');
  });
});
