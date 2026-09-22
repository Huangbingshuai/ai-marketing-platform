import array
import asyncio
import shutil
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
import pytest
from effect_template_mix import final_output
from effect_template_mix.final_output import captions_ass, command, encode, probe, render, FinalOutputHandler
from effect_template_mix.api import InternalApi
from effect_template_mix.packaging_provider import PackagingError


def test_caption_escaping_and_bounds() -> None:
    ass = captions_ass([{'text': '{\\pos(0,0)}商品', 'start': .2, 'end': .9}], 720, 960, 1)
    assert '{\\pos' not in ass and '商品' in ass
    with pytest.raises(PackagingError):
        captions_ass([{'text': '商品', 'start': .2, 'end': 1.2}], 720, 960, 1)


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg is required for real local rendering')
@pytest.mark.parametrize('transition', ['硬切', *final_output.TRANSITIONS, '六镜头混合'])
async def test_real_h264_aac_render_has_exact_duration_audio_and_last_frame(tmp_path: Path, monkeypatch: Any, transition: str) -> None:
    monkeypatch.setattr(final_output, 'output_size', lambda _: (160, 120))
    async def diagnostic_command(program: str, args: list[str], timeout: float = 900, cwd: Path | None = None) -> bytes:
        try:
            return await command(program, args, timeout, cwd)
        except PackagingError:
            # Synthetic fixture inputs only: retain FFmpeg diagnostics without exposing real project data.
            process = await asyncio.create_subprocess_exec(program, *args, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            _, error = await process.communicate()
            print(error.decode(errors='replace'))
            raise
    monkeypatch.setattr(final_output, 'command', diagnostic_command)
    a, b, voice, music = [tmp_path / name for name in ('a.mp4', 'b.mp4', 'voice.wav', 'music.wav')]
    await encode(['-f', 'lavfi', '-i', 'color=red:s=160x120:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(a)], tmp_path)
    await encode(['-f', 'lavfi', '-i', 'color=blue:s=160x120:r=30:d=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(b)], tmp_path)
    for target, length, frequency in [(voice, .5, 440), (music, 4, 110)]:
        await encode(['-f', 'lavfi', '-i', f'sine=frequency={frequency}:duration={length}', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', str(target)], tmp_path)
    clips = [{'fileObjectId': 'a', 'start': 0, 'duration': 2, 'offset': 0, 'lane': 0, 'transition': '硬切', 'transitionDuration': 0},
             {'fileObjectId': 'b', 'start': 2, 'duration': 2, 'offset': 0, 'lane': 0, 'transition': transition, 'transitionDuration': .4}]
    if transition == '六镜头混合':
        clips = [{'fileObjectId': 'a' if i % 2 == 0 else 'b', 'start': i * 2, 'duration': 2,
                  'offset': 0, 'lane': 0, 'transition': kind, 'transitionDuration': .4}
                 for i, kind in enumerate(['硬切', '硬切', '叠化', '左滑', '硬切', '闪白'])]
    duration = len(clips) * 2
    snapshot = {'timeline': {'duration': duration, 'clips': clips}, 'aspectRatio': '4:3', 'originalVolume': .15,
        'packaging': {'voices': {'line': {'fileObjectId': 'voice', 'start': .3, 'duration': .5, 'volume': 1}},
            'music': {'fileObjectId': 'music', 'volume': .12}, 'captions': [{'text': '本地测试字幕', 'start': .3, 'end': .8}]}}
    progress = AsyncMock()
    result = await render(snapshot, {'a': a, 'b': b, 'voice': voice, 'music': music}, tmp_path, progress)
    metadata = await probe(result)
    assert abs(float(metadata['format']['duration']) - duration) < .1
    assert {s['codec_name'] for s in metadata['streams']} == {'h264', 'aac'}
    pcm = await command('ffmpeg', ['-v', 'error', '-i', str(result), '-ss', '0.35', '-t', '0.2', '-vn', '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'])
    samples = array.array('h', pcm)
    assert max(abs(x) for x in samples) > 100
    frame = await command('ffmpeg', ['-v', 'error', '-ss', str(duration - .1), '-i', str(result), '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    assert len(frame) == 3 and frame[2] > 150 and frame[0] < 50  # Last real blue frame, not black.
    assert progress.call_args.args == (95,)


async def test_completed_output_is_not_rendered_again() -> None:
    api = AsyncMock(spec=InternalApi)
    api.ROOT = 'internal/workers/effect-template-mix'
    api.request.return_value = {'terminal': False, 'attemptToken': 'token', 'items': [{'status': 'COMPLETED'}]}
    message = AsyncMock()
    await FinalOutputHandler(api, 1000).handle(message, {'projectId': '11111111-1111-4111-8111-111111111111', 'runId': '22222222-2222-4222-8222-222222222222'})
    message.ack.assert_awaited_once()
    assert not any('/video' in call.args[1] for call in api.request.call_args_list)
