"""Run explicitly inside the existing worker: no HTTP, model credentials or user assets."""
import asyncio
import io
import tempfile
import wave
from pathlib import Path

from effect_template_mix.packaging_media import analysis_preview, ffmpeg, music_wav


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix='packaging-smoke-') as name:
        directory = Path(name)
        video = directory / 'red.mp4'
        await ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=240x320:r=24', '-t', '2', '-c:v', 'libx264', '-y', str(video))
        frames = await analysis_preview({'duration': 2.5, 'clips': [{'fileObjectId': 'f', 'start': .5, 'offset': 0, 'duration': 2, 'lane': 0}]}, {'f': video}, directory)
        assert len(frames) >= 12 and all(data.startswith(b'\xff\xd8') for _, data in frames)
        source = directory / 'tone.wav'
        await ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '0.7', '-ac', '1', '-c:a', 'pcm_s16le', '-y', str(source))
        converted = await music_wav(source.read_bytes(), directory, 2.5)
        with wave.open(io.BytesIO(converted)) as sound:
            assert sound.getnchannels() == 2 and sound.getframerate() == 48000
            assert abs(sound.getnframes() / sound.getframerate() - 2.5) < .001
        print(f'PASS: low-resolution preview, gap handling, {len(frames)} JPEG frames, PCM WAV loop/crop 2.5s')


if __name__ == '__main__':
    asyncio.run(main())
