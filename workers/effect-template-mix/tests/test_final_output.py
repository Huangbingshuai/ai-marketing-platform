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


def test_editor_reworded_subtitle_burns_its_own_text_not_the_narration() -> None:
    # The editor may reword a caption while the spoken line keeps its original script text.
    ass = captions_ass([{'text': '限时五折', 'start': .2, 'end': .9}], 720, 960, 1)
    assert '限时五折' in ass and '商品' not in ass
    assert 'Style: Default' in ass and ',2,' in ass  # bottom-centre alignment is unchanged


def test_segmented_subtitles_burn_as_two_separate_events() -> None:
    captions = [
        {'id': 'caption-a', 'voiceLineId': 'slot-a', 'segmentIndex': 0, 'segmentCount': 2,
         'text': '新鲜出锅', 'start': .2, 'end': 1.1},
        {'id': 'caption-b', 'voiceLineId': 'slot-a', 'segmentIndex': 1, 'segmentCount': 2,
         'text': '趁热享用', 'start': 1.1, 'end': 2.1},
    ]
    events = [line for line in captions_ass(captions, 720, 960, 3).splitlines() if line.startswith('Dialogue:')]
    assert len(events) == 2
    assert events[0].endswith('新鲜出锅') and events[1].endswith('趁热享用')
    assert '，' not in ''.join(events)


def test_caption_box_moves_wraps_and_scales_one_event() -> None:
    caption = [{'id': 'a1', 'text': '限时五折优惠活动今天最后一天抓紧时间下单抢购', 'start': .2, 'end': .9}]
    # 0.25 of 720 puts the block centre at 180; a 0.4 wrap is 288px, so margins are 36/396.
    line = [row for row in captions_ass(caption, 720, 1280, 1, {'a1': {'x': .25, 'y': .08, 'width': .4, 'scale': 1}}).splitlines() if row.startswith('Dialogue')][0]
    assert line.startswith('Dialogue: 0,0:00:00.20,0:00:00.90,Default,,36,396,102,,')
    assert '\\N' in line  # CJK is wrapped here because libass itself only breaks at spaces
    assert line.count('\\N') >= 1 and line.endswith('抢购')
    # Font scale is relative to the pipeline default of width / 22.
    big = [row for row in captions_ass(caption, 720, 1280, 1, {'a1': {'x': .5, 'y': .5, 'width': .9, 'scale': 2}}).splitlines() if row.startswith('Dialogue')][0]
    assert '{\\fs66}' in big and ',640,,' in big


def test_caption_without_a_box_keeps_the_pipeline_style_byte_for_byte() -> None:
    caption = [{'id': 'a1', 'text': '本地测试字幕', 'start': .2, 'end': .9}]
    plain = captions_ass(caption, 720, 960, 1)
    assert plain == captions_ass(caption, 720, 960, 1, {})
    # An editor box for a caption that is not in this list must not leak onto it.
    assert plain == captions_ass(caption, 720, 960, 1, {'other': {'x': .5, 'y': .5, 'width': .9, 'scale': 2}})
    assert ',0,0,0,,' in plain and '\\fs' not in plain


def test_caption_box_never_leaves_the_frame() -> None:
    caption = [{'id': 'a1', 'text': '限时五折优惠活动今天最后一天抓紧时间下单抢购', 'start': .2, 'end': .9}]
    line = [row for row in captions_ass(caption, 720, 1280, 1, {'a1': {'x': 1, 'y': 1, 'width': 1, 'scale': 4}}).splitlines() if row.startswith('Dialogue')][0]
    left, right, bottom = (int(value) for value in line.split(',,')[1].split(',')[:3])
    assert left == 0 and right == 0  # a full-width box is pinned inside the frame
    assert 0 <= bottom <= 1280


def test_stream_duration_falls_back_to_duration_ticks() -> None:
    assert final_output.stream_duration({'duration_ts': '1500', 'time_base': '1/1000'}) == 1.5


async def test_audio_led_container_cannot_hide_a_short_video_track(tmp_path: Path, monkeypatch: Any) -> None:
    async def fake_probe(path: Path) -> dict[str, Any]:
        if path.name == 'a.mp4':
            return {'format': {'duration': '5.0'}, 'streams': [
                {'codec_type': 'video', 'duration': '3.0', 'avg_frame_rate': '30/1'},
                {'codec_type': 'audio', 'duration': '5.0'},
            ]}
        return {'format': {'duration': '4.0'}, 'streams': [
            {'codec_type': 'audio', 'duration': '4.0'},
        ]}

    encode_mock = AsyncMock()
    monkeypatch.setattr(final_output, 'probe', fake_probe)
    monkeypatch.setattr(final_output, 'encode', encode_mock)
    snapshot = {
        'timeline': {'duration': 4, 'clips': [
            {'fileObjectId': 'a', 'start': 0, 'duration': 4, 'offset': 0, 'lane': 0},
        ]},
        'aspectRatio': '4:3', 'originalVolume': .15,
        'packaging': {
            'voices': {},
            'music': {'fileObjectId': 'music', 'duration': 4, 'volume': .12},
            'captions': [],
        },
    }

    with pytest.raises(PackagingError, match='源视频画面轨时长不足'):
        await render(snapshot, {
            'a': tmp_path / 'a.mp4', 'music': tmp_path / 'music.wav',
        }, tmp_path, AsyncMock())
    encode_mock.assert_not_awaited()


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


def snapshot_with_audio(voices: dict[str, Any], music: dict[str, Any]) -> dict[str, Any]:
    clips = [{'fileObjectId': 'a', 'start': 0, 'duration': 4, 'offset': 0, 'lane': 0, 'transition': '硬切', 'transitionDuration': 0}]
    return {'timeline': {'duration': 4, 'clips': clips}, 'aspectRatio': '4:3', 'originalVolume': .15,
        'packaging': {'voices': voices, 'music': music, 'captions': [{'text': '本地测试字幕', 'start': .2, 'end': .5}]}}


def capture_filters(monkeypatch: Any) -> list[str]:
    """Record the final filter graph instead of shelling out to FFmpeg."""
    captured: list[str] = []
    async def fake_encode(args: list[str], cwd: Path) -> None:
        if '-filter_complex' in args:
            captured.extend(args[args.index('-filter_complex') + 1].split(';'))
    async def fake_probe(path: Path) -> dict[str, Any]:
        return {'format': {'duration': '4.0'}, 'streams': [
            {'codec_type': 'video', 'codec_name': 'h264', 'duration': '4.0'},
            {'codec_type': 'audio', 'codec_name': 'aac', 'duration': '4.0'}]}
    monkeypatch.setattr(final_output, 'encode', fake_encode)
    monkeypatch.setattr(final_output, 'probe', fake_probe)
    return captured


async def test_edited_voice_and_music_geometry_reaches_the_filter_graph(tmp_path: Path, monkeypatch: Any) -> None:
    """Trimmed voices and moved/trimmed BGM must keep ducking and fades on the timeline."""
    filters = capture_filters(monkeypatch)
    snapshot = snapshot_with_audio(
        {'line': {'fileObjectId': 'voice', 'start': 1.2, 'duration': .5, 'volume': .8, 'offset': .2}},
        {'fileObjectId': 'music', 'start': 1.0, 'duration': 1.5, 'volume': .12, 'offset': .5})
    await render(snapshot, {'a': tmp_path / 'a.mp4', 'voice': tmp_path / 'voice.wav',
        'music': tmp_path / 'music.wav'}, tmp_path, AsyncMock())
    voice = next(f for f in filters if f.endswith('[voice0]'))
    music = next(f for f in filters if f.endswith('[music]'))
    assert 'atrim=start=0.2:duration=0.5,asetpts=PTS-STARTPTS,volume=0.8,adelay=1200:all=1' in voice
    assert 'atrim=start=0.5,asetpts=PTS-STARTPTS,atrim=duration=1.5,adelay=1000:all=1' in music
    # Fades and ducking run after `adelay`, so they use timeline seconds.
    assert 'between(t,1.2,1.7)' in music
    assert 'afade=t=in:st=1.0:d=0.5' in music and 'afade=t=out:st=2.0:d=0.5' in music


async def test_editor_fades_reach_the_filter_graph_in_timeline_seconds(tmp_path: Path, monkeypatch: Any) -> None:
    """Editor fades override the pipeline default; the music fallback stays 0.5s."""
    filters = capture_filters(monkeypatch)
    snapshot = snapshot_with_audio(
        {'line': {'fileObjectId': 'voice', 'start': 1.2, 'duration': .5, 'volume': .8,
            'fadeIn': .1, 'fadeOut': .2}},
        {'fileObjectId': 'music', 'start': 1.0, 'duration': 1.5, 'volume': .12,
            'fadeIn': .3, 'fadeOut': .4})
    await render(snapshot, {'a': tmp_path / 'a.mp4', 'voice': tmp_path / 'voice.wav',
        'music': tmp_path / 'music.wav'}, tmp_path, AsyncMock())
    voice = next(f for f in filters if f.endswith('[voice0]'))
    music = next(f for f in filters if f.endswith('[music]'))
    # Timeline seconds, not source seconds: the narration sits at 1.2 for .5s.
    assert 'adelay=1200:all=1,afade=t=in:st=1.2:d=0.1,afade=t=out:st=1.5:d=0.2[voice0]' in voice
    assert 'afade=t=in:st=1.0:d=0.3' in music and 'afade=t=out:st=2.1:d=0.4' in music


async def test_untouched_audio_keeps_the_pre_fade_filter_graph(tmp_path: Path, monkeypatch: Any) -> None:
    """A checkpoint with no fade keys must render exactly as it did before fades existed."""
    filters = capture_filters(monkeypatch)
    snapshot = snapshot_with_audio(
        {'line': {'fileObjectId': 'voice', 'start': 1.2, 'duration': .5, 'volume': .8, 'offset': .2}},
        {'fileObjectId': 'music', 'start': 1.0, 'duration': 1.5, 'volume': .12, 'offset': .5})
    await render(snapshot, {'a': tmp_path / 'a.mp4', 'voice': tmp_path / 'voice.wav',
        'music': tmp_path / 'music.wav'}, tmp_path, AsyncMock())
    voice = next(f for f in filters if f.endswith('[voice0]'))
    music = next(f for f in filters if f.endswith('[music]'))
    assert voice.endswith('adelay=1200:all=1[voice0]') and 'afade' not in voice
    # The music bed falls back to min(0.5, length / 2).
    assert 'afade=t=in:st=1.0:d=0.5' in music and 'afade=t=out:st=2.0:d=0.5' in music


@pytest.mark.parametrize('fade', [{'fadeIn': -.1}, {'fadeOut': -.1}, {'fadeIn': float('nan')},
    {'fadeIn': 0.4, 'fadeOut': 0.4}])
async def test_unusable_fades_are_rejected(tmp_path: Path, monkeypatch: Any, fade: dict[str, float]) -> None:
    capture_filters(monkeypatch)
    files = {'a': tmp_path / 'a.mp4', 'voice': tmp_path / 'voice.wav', 'music': tmp_path / 'music.wav'}
    snapshot = snapshot_with_audio(
        {'line': {'fileObjectId': 'voice', 'start': 1.2, 'duration': .5, 'volume': .8, **fade}},
        {'fileObjectId': 'music', 'start': 0, 'duration': 4, 'volume': .12})
    with pytest.raises(PackagingError):
        await render(snapshot, files, tmp_path, AsyncMock())


async def test_audio_geometry_beyond_the_frozen_timeline_is_rejected(tmp_path: Path, monkeypatch: Any) -> None:
    capture_filters(monkeypatch)
    over_voice = snapshot_with_audio(
        {'line': {'fileObjectId': 'voice', 'start': 3.8, 'duration': .5, 'volume': 1, 'offset': 0}},
        {'fileObjectId': 'music', 'start': 0, 'duration': 4, 'volume': .12})
    with pytest.raises(PackagingError):
        await render(over_voice, {'a': tmp_path / 'a.mp4', 'voice': tmp_path / 'voice.wav',
            'music': tmp_path / 'music.wav'}, tmp_path, AsyncMock())
    over_music = snapshot_with_audio(
        {'line': {'fileObjectId': 'voice', 'start': .3, 'duration': .5, 'volume': 1}},
        {'fileObjectId': 'music', 'start': 2.0, 'duration': 4, 'volume': .12})
    with pytest.raises(PackagingError):
        await render(over_music, {'a': tmp_path / 'a.mp4', 'voice': tmp_path / 'voice.wav',
            'music': tmp_path / 'music.wav'}, tmp_path, AsyncMock())
