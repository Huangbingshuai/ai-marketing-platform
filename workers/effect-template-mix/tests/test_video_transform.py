import asyncio
import shutil
from pathlib import Path
import pytest
from effect_template_mix.final_output import video_transform_filter, output_size, command
from effect_template_mix.packaging_provider import PackagingError
from effect_template_mix import final_output

IDENTITY = dict(x=0, y=0, scaleX=1, scaleY=1, rotation=0, uniform=True)
INFO = {'streams': [{'codec_type': 'video', 'width': 100, 'height': 100}]}

@pytest.mark.parametrize('ratio', ['2.35:1', '2:1', '1.85:1', '9:19.5', '123:456'])
def test_custom_and_menu_ratios(ratio: str) -> None:
    w, h = output_size(ratio, '480p')
    assert w % 2 == h % 2 == 0 and min(w, h) == 480

@pytest.mark.parametrize('ratio', ['adaptive', '0:1', '1:0', '100:1', '1:100', 'nan:1'])
def test_invalid_canvas(ratio: str) -> None:
    with pytest.raises(PackagingError):
        output_size(ratio)

@pytest.mark.parametrize('patch', [dict(x=float('nan')), dict(y=3), dict(scaleX=0), dict(scaleY=6), dict(rotation=181)])
def test_invalid_transform(patch: dict) -> None:
    with pytest.raises(PackagingError):
        video_transform_filter(100, 100, {'transform': {**IDENTITY, **patch}}, INFO)

@pytest.mark.parametrize('transform', [
    {**IDENTITY, 'scaleX': .5, 'scaleY': .5, 'x': .2},
    {**IDENTITY, 'scaleX': .5, 'scaleY': .25, 'y': -.2, 'rotation': 90},
    {**IDENTITY, 'scaleX': 2, 'scaleY': 1.5, 'x': -.4, 'rotation': 35},
])
def test_real_ffmpeg_transform_renders_expected_geometry(tmp_path: Path, transform: dict) -> None:
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg unavailable')
    async def run() -> bytes:
        dest = tmp_path / 'frame.rgb'
        filters = video_transform_filter(100, 100, {'transform': transform}, INFO)
        await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
            'color=red:s=100x100:d=0.1', '-vf', filters, '-frames:v', '1', '-pix_fmt', 'rgb24',
            '-f', 'rawvideo', str(dest)], cwd=tmp_path)
        return dest.read_bytes()
    pixels = asyncio.run(run())
    assert len(pixels) == 100 * 100 * 3
    points = [(index % 100, index // 100) for index in range(10000)
        if pixels[index * 3] > 180 and pixels[index * 3 + 1] < 50]
    assert points
    if transform['rotation'] == 0:
        assert abs(min(x for x, y in points) - 45) <= 2
        assert abs(max(x for x, y in points) - 94) <= 2
    elif transform['rotation'] == 90:
        assert abs(min(x for x, y in points) - 37) <= 2
        assert abs(max(x for x, y in points) - 62) <= 2
        assert abs(min(y for x, y in points) - 5) <= 2
        assert abs(max(y for x, y in points) - 54) <= 2


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg unavailable')
async def test_frozen_transform_reaches_real_final_mp4(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from unittest.mock import AsyncMock
    source = tmp_path / 'source.mp4'
    await final_output.encode(['-f', 'lavfi', '-i', 'color=red:s=80x80:r=24:d=1',
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], tmp_path)
    monkeypatch.setattr(final_output, 'output_size', lambda *_: (160, 80))
    snapshot = {
        'timeline': {'duration': 1, 'clips': [{'fileObjectId': 'source', 'slotId': 's',
            'start': 0, 'duration': 1, 'offset': 0, 'lane': 0,
            'transition': '硬切', 'transitionDuration': 0,
            'transform': {**IDENTITY, 'x': .2, 'scaleX': .5, 'scaleY': .5}}]},
        'aspectRatio': '2:1', 'resolution': '480p', 'frameRate': 24,
        'originalVolume': 0, 'unpackaged': True,
        'packaging': {'voices': {}, 'captions': []},
    }
    result = await final_output.render(snapshot, {'source': source}, tmp_path, AsyncMock())
    metadata = await final_output.probe(result)
    video = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
    assert (video['width'], video['height']) == (160, 80)
    assert abs(float(metadata['format']['duration']) - 1) < .1
    frame = await command('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', str(result),
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    points = [(index % 160, index // 160) for index in range(160 * 80)
        if frame[index * 3] > 180 and frame[index * 3 + 1] < 50]
    assert abs(min(x for x, _ in points) - 92) <= 2
    assert abs(max(x for x, _ in points) - 131) <= 2
