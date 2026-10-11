"""Confirmed rendering; explicit source refresh reuses trim and slot packaging before encoding."""
import asyncio
import hashlib
import json
import logging
import math
import tempfile
import time
import unicodedata
from collections.abc import Awaitable, Callable
from contextlib import suppress
from contextvars import ContextVar
from fractions import Fraction
from pathlib import Path
from typing import Any, cast
from uuid import UUID

import httpx
from aio_pika.abc import AbstractIncomingMessage
from .api import InternalApi, ApiError
from .final_output_cache import SourceCache, retry_request
from .packaging_media import visible_intervals
from .packaging_provider import PackagingError
from .packaging import PackagingHandler, recover_packaging_item
from .provider import ProviderError, ProviderIncompleteError

LOGGER = logging.getLogger(__name__)
SOURCE_PROBE: ContextVar[Callable[[str, Path], Awaitable[dict[str, Any]]] | None] = ContextVar('final_source_probe', default=None)
STAGE_CONTEXT: ContextVar[dict[str, str] | None] = ContextVar('final_stage_context', default=None)


def output_failure_message(error: Exception, snapshot: dict[str, Any]) -> str:
    """Do not mislabel model failures as encoding, or echo arbitrary provider errors."""
    if isinstance(error, ProviderError):
        refresh = snapshot.get('sourceRefresh') or {}
        stage = refresh.get('stage', 'SNAPSHOT')
        label = ('素材选区' if not refresh.get('trimsReady') else
                 '画面分析' if stage in ('SNAPSHOT', 'VISION') else '口播生成')
        reason = ('模型输出仍不完整' if isinstance(error, ProviderIncompleteError) else
                  'AI 服务超时或暂时不可用，自动重试已用尽' if error.retryable else
                  'AI 配置、响应结构或请求被拒绝')
        return f'{label}失败：{reason}；已保留旧结果和成功步骤，请重试失败项'
    if isinstance(error, PackagingError):
        return str(error)
    return '成片渲染失败或超时，请重试失败项'


def stage(name: str, started: float, **values: int | str | bool) -> None:
    LOGGER.info('final_output_stage %s', json.dumps({**(STAGE_CONTEXT.get() or {}),
        'stage': name, 'durationMs': round((time.monotonic() - started) * 1000), **values}, ensure_ascii=False))
TRANSITIONS = {
    '叠化': 'fade', '推镜': 'zoomin', '缩放': 'zoomin',
    '左滑': 'slideleft', '上推': 'slideup', '擦除': 'wipeleft', '翻转': 'hlslice',
    '圆形展开': 'circleopen', '模糊溶解': 'hblur', '右滑': 'slideright', '下推': 'slidedown',
    '旋转': 'radial', '百叶窗': 'hlslice', '菱形展开': 'diagtl', '像素化': 'pixelize',
    '故障': 'squeezeh', '色差': 'fadegrays', '波纹': 'radial', '闪黑': 'fadeblack',
    '缩小': 'distance', '圆形扩散': 'circleopen', '线性擦除': 'wipeleft', '四角汇聚': 'rectcrop',
    '分割': 'hlslice', '镜像': 'horzclose', '翻页': 'smoothleft', '立方体': 'smoothright',
    '放大模糊': 'hblur', '彩色闪光': 'fadewhite', '噪点溶解': 'dissolve', '液体扭曲': 'radial',
    '斜向擦除': 'diagtl',
}


def transition_filter(transition: str, duration: float, offset: float) -> str:
    if transition == '闪白':
        # xfade's P runs from 1 (outgoing) to 0 (incoming). Match the editor's
        # brief 40% white accent over a normal crossfade, not a full white frame.
        flash = '0.4*pow(max(0,1-abs(2*P-1)*2),2)'
        white = 'if(eq(PLANE,0),235,128)'  # Limited-range YUV white / neutral chroma.
        expression = f'(A*P+B*(1-P))*(1-({flash}))+({white})*({flash})'
        return f"xfade=transition=custom:duration={duration}:offset={offset}:expr='{expression}'"
    return f'xfade=transition={TRANSITIONS[transition]}:duration={duration}:offset={offset}'


async def command(program: str, args: list[str], timeout: float = 900, cwd: Path | None = None) -> bytes:
    process = await asyncio.create_subprocess_exec(program, *args, cwd=cwd,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        async with asyncio.timeout(timeout):
            output, _ = await process.communicate()
        if process.returncode:
            raise PackagingError('成片媒体处理失败，请检查编码、转场和文件完整性')
        return output
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def probe(path: Path) -> dict[str, Any]:
    result = json.loads(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], 30))
    return cast(dict[str, Any], result)


def stream_duration(stream: dict[str, Any]) -> float | None:
    """Read a track's own duration; the container duration may be audio-led."""
    raw_duration = stream.get('duration')
    if raw_duration not in (None, 'N/A'):
        try:
            duration = float(str(raw_duration))
            if math.isfinite(duration) and duration >= 0:
                return duration
        except (TypeError, ValueError):
            pass
    duration_ts, time_base = stream.get('duration_ts'), stream.get('time_base')
    if duration_ts not in (None, 'N/A') and time_base not in (None, 'N/A'):
        try:
            duration = float(str(duration_ts)) * float(Fraction(str(time_base)))
            if math.isfinite(duration) and duration >= 0:
                return duration
        except (TypeError, ValueError, ZeroDivisionError):
            pass
    return None


def video_stream(info: dict[str, Any]) -> dict[str, Any]:
    stream = next((row for row in info.get('streams', []) if row.get('codec_type') == 'video'), None)
    if stream is None:
        raise PackagingError('视频素材没有可用的画面轨')
    return cast(dict[str, Any], stream)


def frame_tolerance(stream: dict[str, Any], output_frame_rate: int) -> float:
    tolerances = [1 / output_frame_rate]
    for key in ('avg_frame_rate', 'r_frame_rate'):
        try:
            source_rate = float(Fraction(str(stream.get(key, '0/1'))))
            if math.isfinite(source_rate) and source_rate > 0:
                tolerances.append(1 / source_rate)
                break
        except (ValueError, ZeroDivisionError):
            continue
    return max(tolerances) + .002


def validate_video_interval(
    info: dict[str, Any], offset: float, length: float, output_frame_rate: int,
) -> None:
    stream = video_stream(info)
    duration = stream_duration(stream)
    try:
        start = float(stream.get('start_time', 0) or 0)
    except (TypeError, ValueError):
        start = 0
    if duration is None or not math.isfinite(start):
        raise PackagingError('无法确认源视频画面轨的真实时长，已停止导出')
    tolerance = frame_tolerance(stream, output_frame_rate)
    available_end = start + duration
    if offset < start - tolerance or offset + length > available_end + tolerance:
        raise PackagingError('源视频画面轨时长不足，不能用尾帧冻结补足成片')


async def encode(args: list[str], cwd: Path) -> None:
    # Input/global options only. `-threads` is positional: here it caps the decoder, and the two
    # filter options cap the filter graph. The encoder is deliberately left uncapped so x264 can
    # use the machine -- capping it at the output side made a 44s 720p export ~3.5x slower.
    # Overall parallelism is bounded by FINAL_OUTPUT_MAX_CONCURRENCY, not by per-process threads.
    await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
        '-filter_complex_threads', '1', '-filter_threads', '1', *args], cwd=cwd)


def output_size(ratio: str, resolution: str = '720p') -> tuple[int, int]:
    import re
    if not isinstance(ratio, str) or not re.fullmatch(r'\d+(?:\.\d+)?:\d+(?:\.\d+)?', ratio):
        raise PackagingError('不支持的工程画幅，请检查已确认渲染配置')
    first, second = (float(part) for part in ratio.split(':'))
    if not all(math.isfinite(v) and v > 0 for v in (first, second)) or not .25 <= first / second <= 4:
        raise PackagingError('工程画幅超出范围')
    short_edge = {'480p': 480, '720p': 720, '1080p': 1080, '2K': 1440, '4K': 2160}.get(resolution)
    if short_edge is None:
        raise PackagingError('不支持的输出分辨率')
    if first >= second:
        return round(short_edge * first / second / 2) * 2, short_edge
    return short_edge, round(short_edge * second / first / 2) * 2


def video_transform_filter(width: int, height: int, clip: dict[str, Any] | None,
                           info: dict[str, Any] | None) -> str:
    """Crop near-matching codec ratios before user transforms; contain genuinely different ratios."""
    # Keep the symmetric 1% tolerance aligned with effectVideoCanvasFit in contracts.
    try:
        source = next(s for s in (info or {})['streams'] if s['codec_type'] == 'video')
        sw, sh = float(source['width']), float(source['height'])
        sar = source.get('sample_aspect_ratio', '1:1')
        if sar not in (None, 'N/A', '0:1'):
            a, b = str(sar).split(':')
            sw *= float(a) / float(b)
        if not all(math.isfinite(v) and v > 0 for v in (sw, sh)):
            raise ValueError()
    except (ValueError, KeyError, ZeroDivisionError, StopIteration, TypeError):
        sw = sh = 0.0
    matching = sw > 0 and sh > 0 and max((sw / sh) / (width / height), (width / height) / (sw / sh)) <= 1.01
    cover = max(width / sw, height / sh) if matching else 0.0
    cover_w = math.ceil(sw * cover / 2 - 1e-9) * 2 if matching else 0
    cover_h = math.ceil(sh * cover / 2 - 1e-9) * 2 if matching else 0
    baseline = (f'scale={cover_w}:{cover_h},setsar=1,'
                f'crop={width}:{height}:(iw-ow)/2:(ih-oh)/2,') if matching else ''
    t = (clip or {}).get('transform')
    if not t:
        if matching:
            return baseline.rstrip(',')
        return (f'scale={width}:{height}:force_original_aspect_ratio=decrease,'
            f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1')
    try:
        x, y, sx, sy, rotation = (float(t[k]) for k in ('x', 'y', 'scaleX', 'scaleY', 'rotation'))
        if not all(math.isfinite(v) for v in (x, y, sx, sy, rotation)) or not (
            abs(x) <= 2 and abs(y) <= 2 and .1 <= sx <= 5 and .1 <= sy <= 5 and abs(rotation) <= 180):
            raise ValueError()
        if matching:
            sw, sh = float(width), float(height)
        base = min(width / sw, height / sh)
        scaled_w, scaled_h = max(2, round(sw * base * sx / 2) * 2), max(2, round(sh * base * sy / 2) * 2)
        angle = rotation * math.pi / 180
        rw = abs(math.cos(angle)) * scaled_w + abs(math.sin(angle)) * scaled_h
        rh = abs(math.cos(angle)) * scaled_h + abs(math.sin(angle)) * scaled_w
        dx, dy = round(x * width), round(y * height)
        pw = math.ceil((max(width, rw) + 2 * abs(dx) + 4) / 2) * 2
        ph = math.ceil((max(height, rh) + 2 * abs(dy) + 4) / 2) * 2
    except (ValueError, KeyError, ZeroDivisionError, StopIteration, TypeError):
        raise PackagingError('视频空间变换参数无效') from None
    rotate = f'rotate={angle}:ow=rotw({angle}):oh=roth({angle}):c=black,' if rotation else ''
    return (f'{baseline}scale={scaled_w}:{scaled_h},setsar=1,{rotate}'
        f'pad={pw}:{ph}:(ow-iw)/2:(oh-ih)/2:black,'
        f'crop={width}:{height}:{(pw-width)//2-dx}:{(ph-height)//2-dy}')


def ass_time(value: float, *, round_up: bool = False) -> str:
    # ASS has centisecond precision. Never round a spoken onset down before the word starts.
    ticks = math.ceil(value * 100 - 1e-7) if round_up else round(value * 100)
    return f'{ticks // 360000}:{ticks // 6000 % 60:02d}:{ticks // 100 % 60:02d}.{ticks % 100:02d}'


def escape_ass(text: str) -> str:
    return text.replace('\\', '＼').replace('{', '｛').replace('}', '｝').replace('\r', '').replace('\n', '\\N')


def em_width(char: str) -> float:
    return 1.0 if unicodedata.east_asian_width(char) in 'WF' else 0.5


def wrap_caption(text: str, limit_em: float) -> list[str]:
    """Greedy wrap to `limit_em` ems, honouring existing newlines as hard breaks.

    libass only breaks at spaces, so a CJK caption would run off the frame entirely if we
    left wrapping to it. Breaking here keeps the render identical across libass builds.
    """
    lines: list[str] = []
    for hard in text.split('\n'):
        line, used = '', 0.0
        for char in hard:
            step = em_width(char)
            if line and used + step > limit_em:
                # Prefer a space so Latin words stay whole; CJK has none and breaks anywhere.
                cut = line.rfind(' ')
                if cut > 0:
                    lines.append(line[:cut])
                    line, used = line[cut + 1:], sum(em_width(c) for c in line[cut + 1:])
                else:
                    lines.append(line)
                    line, used = '', 0.0
            line += char
            used += step
        lines.append(line)
    return lines


def _caption_lanes(captions: list[dict[str, Any]], fps: int) -> dict[str, int]:
    """Match the editor's interval packing for explicit, manual, and generated subtitle rows."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for index, row in enumerate(captions):
        row_id = str(row.get('id', f'caption-{index}'))
        packed = {**row, '_renderId': row_id}
        group = (f"track:{row['trackId']}" if row.get('trackId')
                 else f"manual:{row_id}" if row.get('manual') is True else 'legacy-generated')
        groups.setdefault(group, []).append(packed)
    group_order = [
        *sorted((key for key in groups if key.startswith('track:')), reverse=True),
        *sorted((key for key in groups if key.startswith('manual:')), reverse=True),
        *(['legacy-generated'] if 'legacy-generated' in groups else []),
    ]
    lanes: dict[str, int] = {}
    lane_offset = 0
    for group in group_order:
        rows = groups[group]
        ends: list[float] = []
        for row in sorted(rows, key=lambda item: (item['start'], item['_renderId'])):
            start, end = float(row['start']), float(row['end'])
            if row.get('trackId') and any(
                other is not row and start < float(other['end']) - 0.001
                and float(other['start']) < end - 0.001 for other in rows
            ):
                raise PackagingError('字幕越界或重叠')
            available = next((index for index, lane_end in enumerate(ends)
                              if lane_end <= start + 1 / max(1, fps)), -1)
            local_lane = available if available >= 0 else len(ends)
            if local_lane == len(ends):
                ends.append(end)
            else:
                ends[local_lane] = max(start, end)
            lanes[str(row['_renderId'])] = lane_offset + local_lane
        lane_offset += max(1, len(ends))
    return lanes


def captions_ass(captions: list[dict[str, Any]], width: int, height: int, duration: float,
                 boxes: dict[str, dict[str, float]] | None = None, fps: int = 30,
                 caption_font_size: int = 16) -> str:
    font_size = max(8, min(48, int(caption_font_size)))
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,{font_size},&H00FFFFFF,&H00FFFFFF,&H00181818,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,{round(height * .03)},1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    boxes = boxes or {}
    lanes = _caption_lanes(captions, fps)
    # One checkpoint-level size applies to every subtitle, independent of output resolution.
    lane_step = max(28, round(font_size * 1.35))
    for index, row in enumerate(captions):
        start, end = row['start'], row['end']
        if not (math.isfinite(start) and math.isfinite(end)
                and 0 <= start < end <= duration + .001):
            raise PackagingError('字幕越界或重叠')
        raw = str(row['text'])
        if not raw.strip():
            continue
        # A caption without an id simply has no editor geometry and keeps the default style.
        box = boxes.get(str(row.get('id', '')))
        lane = lanes.get(str(row.get('id', f'caption-{index}')), 0)
        # Event margin 0 inherits the configured default style margin; later rows add a full
        # line-height above that baseline rather than a tiny offset from the frame edge.
        lane_bottom = 0 if lane == 0 else round(height * .03) + lane * lane_step
        if not box:
            header += f"Dialogue: 0,{ass_time(start, round_up=True)},{ass_time(end, round_up=True)},Default,,0,0,{lane_bottom},,{escape_ass(raw)}\n"
            continue
        size = font_size
        wrap = max(1, round(float(box['width']) * width))
        # Slack for real font metrics, so libass never decides a line is a pixel too wide.
        lines = wrap_caption(raw, max(1.0, wrap / size * 0.98))
        left = max(0, min(round(float(box['x']) * width - wrap / 2), width - wrap))
        block = round(len(lines) * size * 1.35)
        bottom = max(0, min(round(float(box['y']) * height) + lane * lane_step,
                             max(0, height - block)))
        text = f'{{\\fs{size}}}' + '\\N'.join(escape_ass(line) for line in lines)
        header += f"Dialogue: 0,{ass_time(start, round_up=True)},{ass_time(end, round_up=True)},Default,,{left},{width - wrap - left},{bottom},,{text}\n"
    return header


async def render(snapshot: dict[str, Any], files: dict[str, Path], directory: Path,
                 progress: Callable[[int], Awaitable[None]]) -> Path:
    timeline, cp = snapshot['timeline'], snapshot['packaging']
    duration = float(timeline['duration'])
    resolution = snapshot.get('resolution', '720p')
    frame_rate = int(snapshot.get('frameRate', 30))
    if frame_rate not in {24, 25, 30, 50, 60}:
        raise PackagingError('不支持的输出帧率')
    width, height = output_size(snapshot['aspectRatio'], resolution)
    intervals = visible_intervals(timeline)
    # Every source is probed once, and ffprobe only reads headers, so launch them together: run
    # serially these 13 process starts cost about as much as the render itself does now.
    probing_started = time.monotonic()
    source_probe = SOURCE_PROBE.get()
    probed = await asyncio.gather(*(source_probe(file_id, path) if source_probe else probe(path)
        for file_id, path in files.items()))
    media = dict(zip(files, probed))
    stage('probe', probing_started, sourceCount=len(files))
    await progress(10)
    # One pass: each interval is trimmed straight out of its source clip inside the filter graph,
    # so the timeline is never encoded to intermediate files and decoded a second time.
    inputs: list[str] = []
    filters: list[str] = []
    source_count = 0
    for index, (start, end, clip) in enumerate(intervals):
        length = end - start
        if clip:
            info = media[clip['fileObjectId']]
            offset = float(clip['offset'] + start - clip['start'])
            # The guard the old post-encode segment check performed: the source picture track must
            # really cover the interval, so a short clip can never be padded out to full length.
            validate_video_interval(info, offset, length, frame_rate)
            inputs += ['-ss', str(offset), '-t', str(length), '-i', str(files[clip['fileObjectId']])]
            has_audio = not clip.get('originalAudioDetached', False) and any(
                s['codec_type'] == 'audio' for s in info['streams'])
        else:
            inputs += ['-f', 'lavfi', '-t', str(length), '-i', f'color=c=black:s={width}x{height}:r={frame_rate}']
            has_audio = False
        video_index = source_count
        source_count += 1
        if not has_audio:
            inputs += ['-f', 'lavfi', '-t', str(length), '-i', 'anullsrc=r=48000:cl=stereo']
            audio_index = source_count
            source_count += 1
        else:
            audio_index = video_index
        # `apad` before the trim keeps a source whose audio track ends early from shortening the
        # interval; the trim then makes every branch exactly `length` so concat stays aligned.
        geometry = video_transform_filter(width, height, clip, media[clip['fileObjectId']] if clip else None)
        filters += [f'[{video_index}:v]trim=duration={length},setpts=PTS-STARTPTS,'
            f'{geometry},fps={frame_rate},settb=AVTB[v{index}]',
            f'[{audio_index}:a]aresample=48000,apad,atrim=duration={length},asetpts=PTS-STARTPTS[a{index}]']
    # Center transitions on the cut, as in the editor. Padding supplies handles
    # without shortening the frozen timeline or inventing black frames.
    current = 'v0'
    for index in range(1, len(intervals)):
        start, end, clip = intervals[index]
        previous_clip = intervals[index - 1][2]
        transition = clip.get('transition', '硬切') if previous_clip and clip and clip['start'] == start else '硬切'
        length = min(float(clip.get('transitionDuration', 0)) if clip else 0, end - start, intervals[index - 1][1] - intervals[index - 1][0], 5)
        if transition != '硬切' and length >= 1 / frame_rate:
            if transition not in TRANSITIONS and transition != '闪白':
                raise PackagingError('不支持的转场类型')
            # FFmpeg 7 tpad/concat can clear frame_rate (1/0); xfade requires CFR.
            filters += [f'[{current}]fps={frame_rate},tpad=stop_mode=clone:stop_duration={length / 2},fps={frame_rate},settb=AVTB[pad{index}]',
                f'[v{index}]fps={frame_rate},tpad=start_mode=clone:start_duration={length / 2},fps={frame_rate},settb=AVTB[incoming{index}]',
                f'[pad{index}][incoming{index}]'
                f'{transition_filter(transition, length, start - length / 2)}[join{index}]']
        else:
            filters += [f'[{current}][v{index}]concat=n=2:v=1:a=0[join{index}]']
        current = f'join{index}'
    original_volume = max(0, min(1, float(snapshot['originalVolume'])))
    filters += [''.join(f'[a{index}]' for index in range(len(intervals))) + f'concat=n={len(intervals)}:v=0:a=1,volume={original_volume}[original]']
    timeline_audios = list(timeline.get('detachedAudios', []))
    detached = [audio for audio in timeline_audios if audio.get('audioKind') != 'VOICE']
    # Editor edits may trim the source head (`offset`) and move clips along the timeline;
    # pipeline writes stay canonical, so absent keys mean the frozen timeline geometry.
    # A caption narration the editor generated is a narration line in every way the mixer cares
    # about: it takes one amix input and is moved by `offset`/`start`, with independent gain.
    voices = [*cp['voices'].values(), *(cp.get('captionVoices') or {}).values(),
        *(audio for audio in timeline_audios if audio.get('audioKind') == 'VOICE')]
    for index, voice in enumerate(voices):
        actual = float(media[voice['fileObjectId']]['format']['duration'])
        offset = float(voice.get('offset', 0.0))
        start = float(voice['start'])
        length = float(voice['duration'])
        if (not math.isfinite(offset) or offset < 0 or not math.isfinite(start) or start < 0
                or not math.isfinite(length) or length <= 0
                or offset + length > actual + .05 or start + length > duration + .001):
            raise PackagingError('口播真实音频时长与包装不一致')
        # Editor-only and optional: a line the editor never touched carries no fade keys at all.
        fade_in = float(voice.get('fadeIn', 0.0) or 0.0)
        fade_out = float(voice.get('fadeOut', 0.0) or 0.0)
        if (not math.isfinite(fade_in) or not math.isfinite(fade_out)
                or fade_in < 0 or fade_out < 0 or fade_in + fade_out > length + .05):
            raise PackagingError('口播淡入淡出时长无效')
        inputs += ['-i', str(files[voice['fileObjectId']])]
        # Trim the head, re-zero timestamps, then shift to the timeline position. The fades go after
        # `adelay` so their coordinates are timeline seconds, and only when set — that keeps an
        # untouched line's filter byte-identical to the pre-fade pipeline.
        fades = (f',afade=t=in:st={start}:d={fade_in}' if fade_in > 0 else '') + (
            f',afade=t=out:st={start + length - fade_out}:d={fade_out}' if fade_out > 0 else '')
        filters += [f'[{source_count + index}:a]aresample=48000,atrim=start={offset}:duration={length},'
            f'asetpts=PTS-STARTPTS,volume={voice["volume"]},adelay={round(start * 1000)}:all=1{fades}[voice{index}]']
    for index, audio in enumerate(detached):
        file_id = str(audio['fileObjectId'])
        info = media[file_id]
        actual = float(info['format']['duration'])
        offset = float(audio['offset'])
        start = float(audio['start'])
        length = float(audio['duration'])
        volume = float(audio.get('volume', 1.0))
        if (not any(s['codec_type'] == 'audio' for s in info['streams'])
                or not math.isfinite(offset) or offset < 0
                or not math.isfinite(start) or start < 0
                or not math.isfinite(length) or length <= 0
                or not math.isfinite(volume) or volume < 0 or volume > 10
                or (not audio.get('loopSource') and offset + length > actual + .05)
                or start + length > duration + .001):
            raise PackagingError('分离音频源轨道或时间范围无效')
        if audio.get('loopSource'):
            inputs += ['-stream_loop', '-1']
        inputs += ['-i', str(files[file_id])]
        source_index = source_count + len(voices) + index
        fade_in = float(audio.get('fadeIn', 0.0) or 0.0)
        fade_out = float(audio.get('fadeOut', 0.0) or 0.0)
        if (not math.isfinite(fade_in) or not math.isfinite(fade_out)
                or fade_in < 0 or fade_out < 0 or fade_in + fade_out > length + .05):
            raise PackagingError('音频片段淡入淡出时长无效')
        fades = (f',afade=t=in:st={start}:d={fade_in}' if fade_in > 0 else '') + (
            f',afade=t=out:st={start + length - fade_out}:d={fade_out}' if fade_out > 0 else '')
        # Split music, imported audio and narration all retain their own configured gain.
        filters += [f'[{source_index}:a]aresample=48000,atrim=start={offset}:duration={length},'
            f'asetpts=PTS-STARTPTS,volume={volume},adelay={round(start * 1000)}:all=1{fades}[detached{index}]']
    # The editor may delete the packaged bed outright, so its absence is a normal state rather than
    # a broken checkpoint: the mix simply has one input fewer and the film keeps its length.
    music = cp.get('music')
    music_input = ''
    if music:
        music_offset = float(music.get('offset', 0.0))
        music_start = float(music.get('start', 0.0))
        music_length = float(music.get('duration', duration))
        if (not math.isfinite(music_offset) or music_offset < 0 or not math.isfinite(music_start) or music_start < 0
                or not math.isfinite(music_length) or music_length <= 0
                or music_start + music_length > duration + .001):
            raise PackagingError('纯音乐时间范围与包装不一致')
        inputs += ['-stream_loop', '-1', '-i', str(files[music['fileObjectId']])]
        music_index = source_count + len(voices) + len(detached)
        # Fades run after `adelay`, so their time coordinates are timeline seconds.
        # The 0.5s easing is the pipeline default: a checkpoint the editor never touched has no fade
        # keys, and the fallback keeps its rendered audio identical to the pre-fade pipeline.
        fade_in = float(music.get('fadeIn', min(0.5, music_length / 2)) or 0.0)
        fade_out = float(music.get('fadeOut', min(0.5, music_length / 2)) or 0.0)
        if (not math.isfinite(fade_in) or not math.isfinite(fade_out)
                or fade_in < 0 or fade_out < 0 or fade_in + fade_out > music_length + .05):
            raise PackagingError('纯音乐淡入淡出时长无效')
        # A zero duration does not disable FFmpeg's sample-count fade default: omit the filter.
        fades = (f',afade=t=in:st={music_start}:d={fade_in}' if fade_in > 0 else '') + (
            f',afade=t=out:st={music_start + music_length - fade_out}:d={fade_out}' if fade_out > 0 else '')
        filters += [f"[{music_index}:a]aresample=48000,atrim=start={music_offset},asetpts=PTS-STARTPTS,atrim=duration={music_length},"
            f"adelay={round(music_start * 1000)}:all=1,volume={music['volume']}{fades}[music]"]
        music_input = '[music]'
    filters += ['[original]' + music_input + ''.join(f'[voice{i}]' for i in range(len(voices))) +
        ''.join(f'[detached{i}]' for i in range(len(detached))) +
        f'amix=inputs={1 + (1 if music else 0) + len(voices) + len(detached)}:normalize=0:duration=longest,'
        f'alimiter=limit=0.95,atrim=duration={duration}[audio]']
    (directory / 'captions.ass').write_text(
        captions_ass(cp['captions'], width, height, duration, cp.get('captionBoxes'), frame_rate,
                     int(cp.get('captionFontSize', 16))), encoding='utf-8')
    # Re-apply the selected constant frame rate after concat/xfade. Every interval branch is CFR,
    # but concat can yield a non-integer average rate when adjacent slot durations end between
    # frame boundaries.
    filters += [f'[{current}]fps={frame_rate},subtitles=captions.ass,format=yuv420p[video]']
    output = directory / 'final.mp4'
    await progress(50)
    encoding_started = time.monotonic()
    await encode([*inputs, '-filter_complex', ';'.join(filters), '-map', '[video]', '-map', '[audio]', '-shortest', '-t', str(duration),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(output)], directory)
    stage('encode', encoding_started)
    output_probe_started = time.monotonic()
    result = await probe(output)
    stage('output_probe', output_probe_started)
    if abs(float(result['format']['duration']) - duration) > .1:
        raise PackagingError('最终视频时长与时间轴不一致')
    video_streams = [s for s in result['streams'] if s.get('codec_type') == 'video']
    if any(abs(float(s.get('duration', 0)) - duration) > .1 for s in video_streams):
        raise PackagingError('画面轨道提前结束，禁止用音频时长伪装完整成片')
    if any(s.get('width') != width or s.get('height') != height for s in video_streams):
        raise PackagingError('最终视频分辨率与所选设置不一致')
    if any(Fraction(str(s.get('avg_frame_rate', '0/1'))) != frame_rate for s in video_streams):
        raise PackagingError('最终视频帧率与所选设置不一致')
    if not any(s.get('codec_name') == 'h264' for s in result['streams']) or not any(s.get('codec_name') == 'aac' for s in result['streams']):
        raise PackagingError('最终视频编码校验失败')
    await progress(95)
    return output


class FinalOutputHandler:
    def __init__(self, api: InternalApi, max_video_bytes: int, max_concurrency: int = 2,
                 packaging: PackagingHandler | None = None) -> None:
        self.api, self.max_video_bytes = api, max_video_bytes
        self.max_concurrency = max_concurrency
        self.packaging = packaging

    async def prepare_refresh(self, root: str, endpoint: str, headers: dict[str, str],
                              project_id: str, item: dict[str, Any]) -> dict[str, Any]:
        snapshot: dict[str, Any] = item['snapshot']
        refresh = snapshot.get('sourceRefresh')
        if not refresh or refresh.get('ready'):
            return snapshot
        if self.packaging is None:
            raise PackagingError('素材局部更新的模型和包装服务尚未配置')
        packaging = self.packaging
        if not refresh.get('trimsReady'):
            trims = await self.packaging.select_source_trims(root, endpoint, headers, project_id,
                snapshot['timeline'], refresh['slots'])
            result = await self.api.request('PUT', f'{endpoint}/trims', headers=headers,
                json={'projectId': project_id, 'trims': trims})
            snapshot = result['snapshot']
            item['snapshot'] = snapshot
            refresh = snapshot['sourceRefresh']
        if not refresh.get('ready'):
            package_item = {'id': item['id'], 'snapshot': snapshot['timeline'],
                'checkpoint': snapshot['packaging'], 'stage': refresh.get('stage', 'SNAPSHOT')}
            async def persist_retry(count: int) -> None:
                await self.api.request('PUT', f'{endpoint}/checkpoint', headers=headers,
                    json={'projectId': project_id, 'stage': package_item['stage'],
                          'checkpoint': {'automaticRetries': count}})
            try:
                await recover_packaging_item(package_item,
                    lambda: packaging.process_item(root, headers, project_id, package_item), persist_retry)
            finally:
                # Keep the latest saved stage for accurate terminal messages and recovery.
                refresh['stage'] = package_item['stage']
            snapshot['packaging'] = package_item['checkpoint']
            if package_item.get('outputSnapshot'):
                snapshot = package_item['outputSnapshot']
        return snapshot

    async def _download(self, endpoint: str, file_id: str, project_id: str,
                        headers: dict[str, str], path: Path, semaphore: asyncio.Semaphore) -> tuple[int, int]:
        async def attempt() -> int:
            async with semaphore:
                try:
                    async with self.api.client.stream('GET', f'{endpoint}/files/{file_id}', headers=headers,
                                                      params={'projectId': project_id}) as response:
                        status = getattr(response, 'status_code', 200)
                        if status >= 400:
                            raise ApiError('source unavailable', retryable=status >= 500)
                        response.raise_for_status()
                        size = 0
                        digest = hashlib.sha256()
                        with path.open('wb') as output:
                            async for chunk in response.aiter_bytes():
                                size += len(chunk)
                                if size > self.max_video_bytes:
                                    raise PackagingError('输出源文件超过处理容量')
                                digest.update(chunk)
                                output.write(chunk)
                        response_headers = getattr(response, 'headers', {})
                        expected = int(response_headers.get('content-length', '0') or 0)
                        if expected and size != expected:
                            raise ApiError('source download interrupted', retryable=True)
                        expected_hash = response_headers.get('x-content-sha256')
                        if expected_hash and digest.hexdigest() != expected_hash.strip().lower():
                            raise ApiError('source checksum mismatch', retryable=True)
                        return size
                except (httpx.TimeoutException, httpx.NetworkError) as exc:
                    raise ApiError('source download interrupted', retryable=True) from exc
        size, retries = await retry_request(attempt)
        return cast(int, size), retries

    async def handle(self, message: AbstractIncomingMessage, request: dict[str, Any]) -> None:
        tasks: list[asyncio.Task[None]] = []
        claimed = False
        try:
            project_id, run_id = str(UUID(request['projectId'])), str(UUID(request['runId']))
            root = f'{self.api.ROOT}/final-output-runs/{run_id}'
            claim_started = time.monotonic()
            # Claim changes the attempt token; retrying a lost response could consume our own lease.
            claim = await self.api.request('POST', f'{root}/claim', json={'projectId': project_id})
            stage('claim', claim_started, projectId=project_id, runId=run_id)
            if claim['terminal']:
                await message.ack()
                return
            headers = {'x-attempt-token': claim['attemptToken']}
            SourceCache.sweep()
            cache = SourceCache(project_id, run_id)
            download_limit = asyncio.Semaphore(8)
            # A 100-item batch can outlive RabbitMQ's delivery acknowledgement window.
            # The persisted API lease and recovery scanner own redelivery after this point.
            await message.ack()
            claimed = True
            async def heartbeat() -> None:
                while True:
                    async def renew() -> Any:
                        # Four 20s attempts + 1/2/4s backoff stay inside the 120s lease.
                        async with asyncio.timeout(20):
                            return await self.api.request('PUT', f'{root}/heartbeat', headers=headers,
                                json={'projectId': project_id})
                    await retry_request(renew)
                    await asyncio.sleep(25)
            async def execute(item: dict[str, Any]) -> None:
                endpoint = f"{root}/items/{item['id']}"
                async def progress(value: int) -> None:
                    await retry_request(lambda: self.api.request('PUT', f'{endpoint}/progress', headers=headers,
                        json={'projectId': project_id, 'progress': value}))
                context = STAGE_CONTEXT.set({'projectId': project_id, 'runId': run_id, 'itemId': str(item['id'])})
                item_started = time.monotonic()
                try:
                    await progress(1)
                    snapshot = await self.prepare_refresh(root, endpoint, headers, project_id, item)
                    if snapshot.get('projectRefreshOnly'):
                        await retry_request(lambda: self.api.request('POST', f'{endpoint}/complete-source-refresh',
                            headers=headers, json={'projectId': project_id}))
                        return
                    ids = ({c['fileObjectId'] for c in snapshot['timeline']['clips']}
                        | {a['fileObjectId'] for a in snapshot['timeline'].get('detachedAudios', [])}
                        | {v['fileObjectId'] for v in snapshot['packaging']['voices'].values()}
                        | {v['fileObjectId'] for v in (snapshot['packaging'].get('captionVoices') or {}).values()}
                        | ({snapshot['packaging']['music']['fileObjectId']}
                           if snapshot['packaging'].get('music') else set()))
                    with tempfile.TemporaryDirectory(prefix='effect-output-') as temporary:
                        directory = Path(temporary)
                        paths: dict[str, Path] = {}
                        download_started = time.monotonic()
                        item_limit = asyncio.Semaphore(4)
                        async def source(index: int, file_id: str) -> tuple[str, Path, int, int, bool]:
                            async with item_limit:
                                path = directory / f'input-{index}.bin'
                                size, retries, hit = await cache.get(file_id, path,
                                    lambda part: self._download(endpoint, file_id, project_id, headers, part, download_limit))
                                return file_id, path, size, retries, hit
                        source_tasks = [asyncio.create_task(source(index, file_id))
                            for index, file_id in enumerate(sorted(ids))]
                        try:
                            sources = await asyncio.gather(*source_tasks)
                        except BaseException:
                            for task in source_tasks:
                                task.cancel()
                            await asyncio.gather(*source_tasks, return_exceptions=True)
                            raise
                        paths = {file_id: path for file_id, path, _, _, _ in sources}
                        stage('download', download_started, sourceCount=len(sources),
                            downloadBytes=sum(row[2] for row in sources), retryCount=sum(row[3] for row in sources),
                            cacheHits=sum(int(row[4]) for row in sources))
                        probe_context = SOURCE_PROBE.set(lambda file_id, path: cache.probe(file_id, path, probe))
                        try:
                            output_path = await render(snapshot, paths, directory, progress)
                        finally:
                            SOURCE_PROBE.reset(probe_context)
                        upload_started = time.monotonic()
                        async def upload() -> Any:
                            with output_path.open('rb') as rendered_file:
                                return await self.api.request('POST', f'{endpoint}/video', headers=headers,
                                    data={'projectId': project_id}, files={'file': ('final.mp4', rendered_file, 'video/mp4')})
                        _, upload_retries = await retry_request(upload)
                        stage('upload', upload_started, uploadBytes=output_path.stat().st_size, retryCount=upload_retries)
                except ApiError as exc:
                    if '租约已失效' in str(exc):
                        raise
                    LOGGER.warning('final_output_item_failed %s', json.dumps({**(STAGE_CONTEXT.get() or {}),
                        'exceptionType': type(exc).__name__, 'retryable': exc.retryable,
                        'retryCount': 3 if exc.retryable else 0}))
                    await retry_request(lambda: self.api.request('PUT', f'{endpoint}/progress', headers=headers,
                        json={'projectId': project_id, 'progress': 0,
                              'errorMessage': '成片源文件或上传暂时不可用，请重试失败项' if exc.retryable
                              else '输出来源或结果校验失败，请回模板混剪恢复'}))
                except Exception as exc:
                    LOGGER.warning('final_output_item_failed %s', json.dumps({**(STAGE_CONTEXT.get() or {}),
                        'exceptionType': type(exc).__name__}))
                    await retry_request(lambda: self.api.request('PUT', f'{endpoint}/progress', headers=headers,
                        json={'projectId': project_id, 'progress': 0,
                              'errorMessage': output_failure_message(exc, item['snapshot'])}))
                finally:
                    stage('item', item_started)
                    STAGE_CONTEXT.reset(context)
            async def work() -> None:
                pending = iter(i for i in claim['items'] if i['status'] in ('QUEUED', 'RUNNING'))
                async def consume() -> None:
                    for item in pending:
                        try:
                            async with asyncio.timeout(2400):
                                await execute(item)
                        except TimeoutError:
                            await retry_request(lambda: self.api.request('PUT', f"{root}/items/{item['id']}/progress", headers=headers,
                                json={'projectId': project_id, 'progress': 0, 'errorMessage': '单条成片输出超过 40 分钟，已停止并保留其他成功结果'}))
                # 4K jobs need much more decoded-frame memory than smaller exports.
                concurrency = min(self.max_concurrency,
                    1 if any(i['snapshot'].get('resolution') == '4K' for i in claim['items']) else self.max_concurrency)
                async with asyncio.TaskGroup() as group:
                    for _ in range(concurrency):
                        group.create_task(consume())
                # Finish clears the attempt token, so a lost success response cannot be retried
                # with this token. The persisted terminal state remains authoritative.
                await self.api.request('POST', f'{root}/finish', headers=headers,
                    json={'projectId': project_id})
                cache.cleanup()
            tasks = [asyncio.create_task(heartbeat()), asyncio.create_task(work())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except Exception as exc:
            LOGGER.warning('final output interrupted type=%s', type(exc).__name__)
            if not claimed:
                await message.nack(requeue=not message.redelivered)
        finally:
            for task in tasks:
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
