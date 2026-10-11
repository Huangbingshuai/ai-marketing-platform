"""Bounded local analysis proxies and duration-accurate PCM audio; never final export."""
import asyncio
import io
import struct
import wave
from pathlib import Path
from typing import Any

from .packaging_provider import PackagingError


async def ffmpeg(*args: str) -> None:
    process = await asyncio.create_subprocess_exec('ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-threads', '1', *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    try:
        async with asyncio.timeout(180):
            await process.communicate()
        if process.returncode:
            raise PackagingError('包装媒体预处理失败，请检查素材编码')
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def pcm_wav(pcm: bytes, rate: int = 24000) -> tuple[bytes, float]:
    if not pcm or len(pcm) % 2:
        raise PackagingError('配音 PCM 数据无效')
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm)
    return stream.getvalue(), len(pcm) / (2 * rate)


# A caption narration is the one clip whose start *is* another clip's start (the subtitle it speaks),
# so the engine's own lead-in silence plays as the subtitle already being up. Keep a short pre-roll
# so the first phoneme still has its attack; the trailing silence is harmless and left alone.
_CAPTION_VOICE_LEAD_SECONDS = .08
_SILENCE_WINDOW_SECONDS = .02
_SILENCE_FLOOR_RATIO = .08
_SILENCE_FLOOR_ABSOLUTE = .005


def trim_leading_silence(pcm: bytes, rate: int = 24000) -> bytes:
    """Cut the synthesizer's lead-in silence down to `_CAPTION_VOICE_LEAD_SECONDS`.

    Windows of `_SILENCE_WINDOW_SECONDS` are scored by RMS against `max(absolute floor, peak ratio)`,
    which is what separates the noise floor from speech on a real 24 kHz line (measured on a live
    sample: peak RMS .169, threshold .0135, speech onset .68s into a 3.01s clip). Input that never
    crosses the threshold — or that starts sooner than the pre-roll — is returned unchanged.
    """
    if len(pcm) < 2:
        return pcm
    window = max(1, round(rate * _SILENCE_WINDOW_SECONDS)) * 2
    levels = []
    for offset in range(0, len(pcm) - 1, window):
        frame = pcm[offset:offset + window]
        samples = struct.unpack(f'<{len(frame) // 2}h', frame[:len(frame) // 2 * 2])
        levels.append((sum((value / 32768) ** 2 for value in samples) / len(samples)) ** .5)
    if not levels:
        return pcm
    threshold = max(_SILENCE_FLOOR_ABSOLUTE, max(levels) * _SILENCE_FLOOR_RATIO)
    onset = next((index for index, level in enumerate(levels) if level >= threshold), None)
    if onset is None:
        return pcm
    keep = round(rate * _CAPTION_VOICE_LEAD_SECONDS) * 2
    lead = onset * window
    return pcm[lead - keep:] if lead > keep else pcm


async def music_wav(data: bytes, directory: Path, duration: float) -> bytes:
    source = directory / 'music-source.bin'
    source.write_bytes(data)
    output = directory / 'music.wav'
    # Music is not speech PCM: retain stereo detail. Timeline fades are applied
    # once by preview/export, never baked a second time into the reusable file.
    await ffmpeg('-stream_loop', '-1', '-i', str(source), '-t', str(duration), '-vn', '-ac', '2', '-ar', '48000',
                 '-c:a', 'pcm_s16le', '-y', str(output))
    return output.read_bytes()


def visible_intervals(snapshot: dict[str, Any]) -> list[tuple[float, float, dict[str, Any] | None]]:
    clips = snapshot['clips']
    boundaries = sorted({0.0, float(snapshot['duration']), *(float(c['start']) for c in clips),
                         *(float(c['start'] + c['duration']) for c in clips)})
    result = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        # Same top-lane / latest-start / latest-slot priority as the formal player.
        active = [(i, c) for i, c in enumerate(clips) if c['start'] <= start < c['start'] + c['duration']]
        active.sort(key=lambda entry: (entry[1]['lane'], -entry[1]['start'], -entry[0]))
        result.append((start, end, active[0][1] if active else None))
    return result


async def analysis_preview(snapshot: dict[str, Any], paths: dict[str, Path], directory: Path) -> list[tuple[float, bytes]]:
    # Proxy intentionally uses hard cuts. The original transitions are passed separately to vision.
    # Timing, trims, top-lane occlusion and gaps must match the visual timeline exactly.
    chunks = []
    for index, (start, end, clip) in enumerate(visible_intervals(snapshot)):
        output = directory / f'proxy-{index}.mp4'
        if clip:
            inputs = ['-ss', str(clip['offset'] + start - clip['start']), '-i', str(paths[clip['fileObjectId']])]
        else:
            inputs = ['-f', 'lavfi', '-i', 'color=c=black:s=240x320:r=12']
        await ffmpeg(*inputs, '-t', str(end - start), '-an', '-vf',
            'scale=240:320:force_original_aspect_ratio=decrease,pad=240:320:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=12',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', str(output))
        chunks.append(f"file '{output.name}'")
    manifest = directory / 'proxy.txt'
    manifest.write_text('\n'.join(chunks), encoding='utf-8')
    preview = directory / 'analysis.mp4'
    await ffmpeg('-f', 'concat', '-safe', '1', '-i', str(manifest), '-c', 'copy', '-y', str(preview))
    # Each interval has at least one frame; additional samples cap at 60 for capacity.
    timestamps = sorted({round((start + end) / 2, 3) for start, end, _ in visible_intervals(snapshot)} |
                        {round(snapshot['duration'] * (i + .5) / 12, 3) for i in range(12)})
    frames = []
    for index, time in enumerate(timestamps):
        output = directory / f'analysis-{index}.jpg'
        await ffmpeg('-ss', str(time), '-i', str(preview), '-frames:v', '1', '-q:v', '5', '-y', str(output))
        if not output.exists():
            raise PackagingError('分析预览抽帧失败')
        frames.append((time, output.read_bytes()))
    return frames


async def slot_frames(clip: dict[str, Any], path: Path, directory: Path) -> list[bytes]:
    """Seek original footage directly; no proxy encode or concatenation."""
    frames = []
    for index, fraction in enumerate((.15, .5, .85)):
        output = directory / f'frame-{index}.jpg'
        await ffmpeg('-ss', str(clip['offset'] + clip['duration'] * fraction), '-i', str(path),
            '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
            '-q:v', '5', '-y', str(output))
        if not output.exists():
            raise PackagingError('槽位原素材抽帧失败')
        frames.append(output.read_bytes())
    return frames
