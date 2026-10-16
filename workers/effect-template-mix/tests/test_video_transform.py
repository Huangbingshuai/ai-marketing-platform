import asyncio
import shutil
from pathlib import Path
import pytest
from effect_template_mix.final_output import video_transform_filter, output_size, command
from effect_template_mix.packaging_provider import PackagingError
from effect_template_mix import final_output

IDENTITY = dict(x=0, y=0, scaleX=1, scaleY=1, rotation=0, uniform=True)
INFO = {'streams': [{'codec_type': 'video', 'width': 100, 'height': 100}]}

def contract_canvas_ratios() -> list[str]:
    import re
    contract = (Path(__file__).resolve().parents[3] / 'packages/contracts/src/effect-template-mix-transform.ts').read_text(encoding='utf-8')
    menu = contract.split('export const EFFECT_CANVAS_RATIOS = [', 1)[1].split('] as const;', 1)[0]
    return re.findall(r"value: '([^']+)'", menu) + ['7:5', '1:4', '4:1']

@pytest.mark.parametrize('ratio', contract_canvas_ratios())
@pytest.mark.parametrize('resolution', ['480p', '720p', '1080p', '2K', '4K'])
def test_all_canvas_resolutions_use_the_same_crop_policy(ratio: str, resolution: str) -> None:
    w, h = output_size(ratio, resolution)
    for factor in [1, 1.02, 1/1.02]:
        info = {'streams': [{'codec_type': 'video', 'width': w*factor, 'height': h}]}
        filters = video_transform_filter(w, h, {}, info)
        assert f'crop={w}:{h}:(iw-ow)/2:(ih-oh)/2' in filters
        assert 'force_original_aspect_ratio=decrease' not in filters
    for factor in [1.026, 1/1.026]:
        info = {'streams': [{'codec_type': 'video', 'width': w*factor, 'height': h}]}
        assert 'force_original_aspect_ratio=decrease' in video_transform_filter(w, h, {}, info)

@pytest.mark.parametrize('ratio', contract_canvas_ratios())
@pytest.mark.parametrize('direction', [1, -1])
def test_all_canvas_edges_are_covered_in_real_ffmpeg(tmp_path: Path, ratio: str, direction: int) -> None:
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg unavailable')
    w, h = output_size(ratio, '480p')
    # Exercise rounding both wider and taller than each declared canvas.
    sw, sh = (round(w*1.02/2)*2, h) if direction == 1 else (w, round(h*1.02/2)*2)
    info = {'streams': [{'codec_type': 'video', 'width': sw, 'height': sh}]}
    filters = video_transform_filter(w, h, {}, info)
    pixels = asyncio.run(command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
        f'color=red:s={sw}x{sh}:d=0.1', '-vf', filters, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], cwd=tmp_path))
    edges = [y*w+x for y in range(h) for x in range(w) if x in (0,w-1) or y in (0,h-1)]
    assert all(pixels[i*3] > 180 and pixels[i*3+1] < 50 for i in edges)

@pytest.mark.parametrize('size,canvas', [((752,560),(640,480)), ((560,752),(480,640)), ((854,480),(640,360)),
    ((496,864),(270,480)), ((864,496),(480,270)), ((480,864),(270,480))])
@pytest.mark.parametrize('transform', [None, IDENTITY, {**IDENTITY, 'scaleX': .5, 'scaleY': .8}])
def test_matching_canvas_has_no_black_rim(tmp_path: Path, size: tuple[int,int], canvas: tuple[int,int], transform: dict | None) -> None:
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg unavailable')
    sw, sh = size
    w, h = canvas
    info = {'streams':[{'codec_type':'video','width':sw,'height':sh}]}
    filters = video_transform_filter(w,h, {'transform':transform} if transform else {}, info)
    assert f'crop={w}:{h}:(iw-ow)/2:(ih-oh)/2' in filters
    pixels = asyncio.run(command('ffmpeg',['-v','error','-f','lavfi','-i',f'color=red:s={sw}x{sh}:d=0.1',
        '-vf',filters,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],cwd=tmp_path))
    if not transform or transform == IDENTITY:
        # Every boundary pixel is covered; checking just the centre would miss a 1px rim.
        edges = [y*w+x for y in range(h) for x in range(w) if x in (0,w-1) or y in (0,h-1)]
        assert all(pixels[i*3]>180 and pixels[i*3+1]<50 for i in edges)
    else:
        points = [(i%w,i//w) for i in range(w*h) if pixels[i*3]>180]
        assert abs((max(x for x,y in points)-min(x for x,y in points)+1)-w*.5)<=2
        assert abs((max(y for x,y in points)-min(y for x,y in points)+1)-h*.8)<=2

def test_different_ratio_still_letterboxes() -> None:
    info = {'streams':[{'codec_type':'video','width':726,'height':1266}]}
    assert 'force_original_aspect_ratio=decrease' in video_transform_filter(640,480,{},info)

def test_matching_display_ratio_respects_sample_aspect() -> None:
    info = {'streams':[{'codec_type':'video','width':100,'height':100,'sample_aspect_ratio':'4:3'}]}
    assert video_transform_filter(640,480,{},info).startswith('scale=640:480,setsar=1,crop=640:480')

def test_browser_worker_tolerance_is_aligned() -> None:
    import re
    contract = (Path(__file__).resolve().parents[3] / 'packages/contracts/src/effect-template-mix-transform.ts').read_text(encoding='utf-8')
    tolerance = float(re.search(r'EFFECT_VIDEO_MATCHING_ASPECT_TOLERANCE = ([\d.]+)',contract)[1])
    assert tolerance == .025
    for ratio, matching in [(1+tolerance,True),(1/(1+tolerance),True),(1+tolerance+.001,False),
                            (1/(1+tolerance+.001),False)]:
        info = {'streams':[{'codec_type':'video','width':ratio*100,'height':100}]}
        assert ('crop=100:100:(iw-ow)' in video_transform_filter(100,100,{},info)) == matching


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
