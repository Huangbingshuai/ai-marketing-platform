"""Confirmed timeline rendering in the existing worker. No supplier calls."""
import asyncio
import json
import logging
import math
import tempfile
import unicodedata
from collections.abc import Awaitable, Callable
from contextlib import suppress
from pathlib import Path
from typing import Any
from uuid import UUID

from aio_pika.abc import AbstractIncomingMessage
from .api import InternalApi, ApiError
from .packaging_media import visible_intervals
from .packaging_provider import PackagingError

LOGGER = logging.getLogger(__name__)
TRANSITIONS = {
    '叠化': 'fade', '推镜': 'zoomin', '闪白': 'fadewhite', '缩放': 'zoomin',
    '左滑': 'slideleft', '上推': 'slideup', '擦除': 'wipeleft', '翻转': 'hlslice',
    '圆形展开': 'circleopen', '模糊溶解': 'hblur', '右滑': 'slideright', '下推': 'slidedown',
    '旋转': 'radial', '百叶窗': 'hlslice', '菱形展开': 'diagtl', '像素化': 'pixelize',
    '故障': 'squeezeh', '色差': 'fadegrays', '波纹': 'radial', '闪黑': 'fadeblack',
    '缩小': 'distance', '圆形扩散': 'circleopen', '线性擦除': 'wipeleft', '四角汇聚': 'rectcrop',
    '分割': 'hlslice', '镜像': 'horzclose', '翻页': 'smoothleft', '立方体': 'smoothright',
    '放大模糊': 'hblur', '彩色闪光': 'fadewhite', '噪点溶解': 'dissolve', '液体扭曲': 'radial',
    '斜向擦除': 'diagtl',
}


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
    result: dict[str, Any] = json.loads(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], 30))
    return result


async def encode(args: list[str], cwd: Path) -> None:
    await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
        '-filter_complex_threads', '1', '-filter_threads', '1', *args], cwd=cwd)


def output_size(ratio: str) -> tuple[int, int]:
    sizes = {'9:16': (720, 1280), '16:9': (1280, 720), '3:4': (720, 960), '4:3': (960, 720), '1:1': (720, 720), '21:9': (1260, 540)}
    if ratio not in sizes:
        raise PackagingError('不支持的工程画幅，请检查已确认渲染配置')
    return sizes[ratio]


def ass_time(value: float) -> str:
    ticks = round(value * 100)
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


def captions_ass(captions: list[dict[str, Any]], width: int, height: int, duration: float,
                 boxes: dict[str, dict[str, float]] | None = None) -> str:
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK SC,{max(24, round(width / 22))},&H00FFFFFF,&H00FFFFFF,&H00181818,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,{round(height * .08)},1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    boxes = boxes or {}
    previous = 0.0
    for row in captions:
        start, end = row['start'], row['end']
        if not (math.isfinite(start) and math.isfinite(end) and previous <= start < end <= duration + .001):
            raise PackagingError('字幕越界或重叠')
        previous = end
        raw = str(row['text'])
        # A caption without an id simply has no editor geometry and keeps the default style.
        box = boxes.get(str(row.get('id', '')))
        if not box:
            header += f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{escape_ass(raw)}\n"
            continue
        size = max(8, round(max(24, round(width / 22)) * float(box['scale'])))
        wrap = max(1, round(float(box['width']) * width))
        # Slack for real font metrics, so libass never decides a line is a pixel too wide.
        lines = wrap_caption(raw, max(1.0, wrap / size * 0.98))
        left = max(0, min(round(float(box['x']) * width - wrap / 2), width - wrap))
        block = round(len(lines) * size * 1.35)
        bottom = max(0, min(round(float(box['y']) * height), max(0, height - block)))
        text = f'{{\\fs{size}}}' + '\\N'.join(escape_ass(line) for line in lines)
        header += f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,{left},{width - wrap - left},{bottom},,{text}\n"
    return header


async def render(snapshot: dict[str, Any], files: dict[str, Path], directory: Path,
                 progress: Callable[[int], Awaitable[None]]) -> Path:
    timeline, cp = snapshot['timeline'], snapshot['packaging']
    duration = float(timeline['duration'])
    width, height = output_size(snapshot['aspectRatio'])
    intervals = visible_intervals(timeline)
    segments: list[Path] = []
    media = {file_id: await probe(path) for file_id, path in files.items()}
    await progress(10)
    for index, (start, end, clip) in enumerate(intervals):
        target = directory / f'segment-{index}.mp4'
        args: list[str] = []
        if clip:
            info = media[clip['fileObjectId']]
            offset = float(clip['offset'] + start - clip['start'])
            if float(info['format']['duration']) + .05 < offset + end - start:
                raise PackagingError('源视频真实时长不足，禁止补黑伪装完成')
            args += ['-ss', str(offset), '-i', str(files[clip['fileObjectId']])]
            has_audio = not clip.get('originalAudioDetached', False) and any(
                s['codec_type'] == 'audio' for s in info['streams'])
        else:
            args += ['-f', 'lavfi', '-i', f'color=c=black:s={width}x{height}:r=30']
            has_audio = False
        if not has_audio:
            args += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
        args += ['-map', '0:v:0', '-map', '0:a:0' if has_audio else '1:a:0', '-t', str(end - start),
            '-vf', f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30',
            '-af', 'aresample=48000,apad', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-threads', '1', str(target)]
        await encode(args, directory)
        segments.append(target)
        await progress(10 + round(35 * (index + 1) / len(intervals)))
    # Center transitions on the cut, as in the editor. Padding supplies handles
    # without shortening the frozen timeline or inventing black frames.
    inputs = [arg for path in segments for arg in ('-i', str(path))]
    filters: list[str] = []
    for index in range(len(segments)):
        filters.append(f'[{index}:v]settb=AVTB,setpts=PTS-STARTPTS[v{index}]')
    current = 'v0'
    for index in range(1, len(segments)):
        start, end, clip = intervals[index]
        previous_clip = intervals[index - 1][2]
        transition = clip.get('transition', '硬切') if previous_clip and clip and clip['start'] == start else '硬切'
        length = min(float(clip.get('transitionDuration', 0)) if clip else 0, end - start, intervals[index - 1][1] - intervals[index - 1][0], 5)
        if transition != '硬切' and length >= 1 / 30:
            if transition not in TRANSITIONS:
                raise PackagingError('不支持的转场类型')
            # FFmpeg 7 tpad/concat can clear frame_rate (1/0); xfade requires CFR.
            filters += [f'[{current}]fps=30,tpad=stop_mode=clone:stop_duration={length / 2},fps=30,settb=AVTB[pad{index}]',
                f'[v{index}]fps=30,tpad=start_mode=clone:start_duration={length / 2},fps=30,settb=AVTB[incoming{index}]',
                f'[pad{index}][incoming{index}]xfade=transition={TRANSITIONS[transition]}:duration={length}:offset={start - length / 2}[join{index}]']
        else:
            filters += [f'[{current}][v{index}]concat=n=2:v=1:a=0[join{index}]']
        current = f'join{index}'
    original_volume = max(0, min(1, float(snapshot['originalVolume'])))
    filters += [''.join(f'[{index}:a]' for index in range(len(segments))) + f'concat=n={len(segments)}:v=0:a=1,volume={original_volume}[original]']
    detached = list(timeline.get('detachedAudios', []))
    # Editor edits may trim the source head (`offset`) and move clips along the timeline;
    # pipeline writes stay canonical, so absent keys mean the frozen timeline geometry.
    voices = list(cp['voices'].values())
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
        filters += [f'[{len(segments) + index}:a]aresample=48000,atrim=start={offset}:duration={length},'
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
                or offset + length > actual + .05
                or start + length > duration + .001):
            raise PackagingError('分离音频源轨道或时间范围无效')
        inputs += ['-i', str(files[file_id])]
        source_index = len(segments) + len(voices) + index
        filters += [f'[{source_index}:a]aresample=48000,atrim=start={offset}:duration={length},'
            f'asetpts=PTS-STARTPTS,volume={volume},adelay={round(start * 1000)}:all=1[detached{index}]']
    music = cp['music']
    music_offset = float(music.get('offset', 0.0))
    music_start = float(music.get('start', 0.0))
    music_length = float(music.get('duration', duration))
    if (not math.isfinite(music_offset) or music_offset < 0 or not math.isfinite(music_start) or music_start < 0
            or not math.isfinite(music_length) or music_length <= 0
            or music_start + music_length > duration + .001):
        raise PackagingError('纯音乐时间范围与包装不一致')
    inputs += ['-stream_loop', '-1', '-i', str(files[music['fileObjectId']])]
    # Time-window ducking is deterministic, including silent PCM and gaps.
    windows = '+'.join(f'between(t,{float(v["start"])},{float(v["start"]) + float(v["duration"])})' for v in voices) or '0'
    music_index = len(segments) + len(voices) + len(detached)
    # Ducking and fades run after `adelay`, so their time coordinates are timeline seconds.
    # The 0.5s easing is the pipeline default: a checkpoint the editor never touched has no fade
    # keys, and the fallback keeps its rendered audio identical to the pre-fade pipeline.
    fade_in = float(music.get('fadeIn', min(0.5, music_length / 2)) or 0.0)
    fade_out = float(music.get('fadeOut', min(0.5, music_length / 2)) or 0.0)
    if (not math.isfinite(fade_in) or not math.isfinite(fade_out)
            or fade_in < 0 or fade_out < 0 or fade_in + fade_out > music_length + .05):
        raise PackagingError('纯音乐淡入淡出时长无效')
    filters += [f"[{music_index}:a]aresample=48000,atrim=start={music_offset},asetpts=PTS-STARTPTS,atrim=duration={music_length},"
        f"adelay={round(music_start * 1000)}:all=1,volume='{music['volume']}*if(gt({windows},0),0.35,1)':eval=frame,"
        f"afade=t=in:st={music_start}:d={fade_in},afade=t=out:st={music_start + music_length - fade_out}:d={fade_out}[music]",
        '[original][music]' + ''.join(f'[voice{i}]' for i in range(len(voices))) +
        ''.join(f'[detached{i}]' for i in range(len(detached))) +
        f'amix=inputs={2 + len(voices) + len(detached)}:normalize=0:duration=longest,'
        f'alimiter=limit=0.95,atrim=duration={duration}[audio]']
    (directory / 'captions.ass').write_text(
        captions_ass(cp['captions'], width, height, duration, cp.get('captionBoxes')), encoding='utf-8')
    filters += [f'[{current}]subtitles=captions.ass,format=yuv420p[video]']
    output = directory / 'final.mp4'
    await progress(50)
    await encode([*inputs, '-filter_complex', ';'.join(filters), '-map', '[video]', '-map', '[audio]', '-t', str(duration),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-threads', '1', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(output)], directory)
    result = await probe(output)
    if abs(float(result['format']['duration']) - duration) > .1:
        raise PackagingError('最终视频时长与时间轴不一致')
    if any(abs(float(s.get('duration', 0)) - duration) > .1 for s in result['streams'] if s.get('codec_type') == 'video'):
        raise PackagingError('画面轨道提前结束，禁止用音频时长伪装完整成片')
    if not any(s.get('codec_name') == 'h264' for s in result['streams']) or not any(s.get('codec_name') == 'aac' for s in result['streams']):
        raise PackagingError('最终视频编码校验失败')
    await progress(95)
    return output


class FinalOutputHandler:
    def __init__(self, api: InternalApi, max_video_bytes: int) -> None:
        self.api, self.max_video_bytes = api, max_video_bytes

    async def handle(self, message: AbstractIncomingMessage, request: dict[str, Any]) -> None:
        tasks: list[asyncio.Task[None]] = []
        try:
            project_id, run_id = str(UUID(request['projectId'])), str(UUID(request['runId']))
            root = f'{self.api.ROOT}/final-output-runs/{run_id}'
            claim = await self.api.request('POST', f'{root}/claim', json={'projectId': project_id})
            if claim['terminal']:
                await message.ack()
                return
            headers = {'x-attempt-token': claim['attemptToken']}
            async def heartbeat() -> None:
                while True:
                    await self.api.request('PUT', f'{root}/heartbeat', headers=headers, json={'projectId': project_id})
                    await asyncio.sleep(25)
            async def execute(item: dict[str, Any]) -> None:
                endpoint = f"{root}/items/{item['id']}"
                async def progress(value: int) -> None:
                    await self.api.request('PUT', f'{endpoint}/progress', headers=headers, json={'projectId': project_id, 'progress': value})
                try:
                    await progress(1)
                    snapshot = item['snapshot']
                    ids = {c['fileObjectId'] for c in snapshot['timeline']['clips']} | {v['fileObjectId'] for v in snapshot['packaging']['voices'].values()} | {snapshot['packaging']['music']['fileObjectId']}
                    with tempfile.TemporaryDirectory(prefix='effect-output-') as temporary:
                        directory = Path(temporary)
                        paths: dict[str, Path] = {}
                        for index, file_id in enumerate(sorted(ids)):
                            path = directory / f'input-{index}.bin'
                            async with self.api.client.stream('GET', f'{endpoint}/files/{file_id}', headers=headers, params={'projectId': project_id}) as response:
                                response.raise_for_status()
                                size = 0
                                with path.open('wb') as output:
                                    async for chunk in response.aiter_bytes():
                                        size += len(chunk)
                                        if size > self.max_video_bytes:
                                            raise PackagingError('输出源文件超过处理容量')
                                        output.write(chunk)
                            paths[file_id] = path
                        output_path = await render(snapshot, paths, directory, progress)
                        with output_path.open('rb') as rendered_file:
                            await self.api.request('POST', f'{endpoint}/video', headers=headers, data={'projectId': project_id}, files={'file': ('final.mp4', rendered_file, 'video/mp4')})
                except ApiError as exc:
                    if exc.retryable:
                        raise
                    await self.api.request('PUT', f'{endpoint}/progress', headers=headers, json={'projectId': project_id, 'progress': 0, 'errorMessage': '输出来源或结果校验失败，请回模板混剪恢复'})
                except Exception as exc:
                    LOGGER.warning('final output failed item=%s type=%s', item['id'], type(exc).__name__)
                    await self.api.request('PUT', f'{endpoint}/progress', headers=headers, json={'projectId': project_id, 'progress': 0, 'errorMessage': str(exc) if isinstance(exc, PackagingError) else '成片渲染失败或超时，请重试失败项'})
            async def work() -> None:
                pending = iter(i for i in claim['items'] if i['status'] != 'COMPLETED')
                async def consume() -> None:
                    for item in pending:
                        try:
                            async with asyncio.timeout(2400):
                                await execute(item)
                        except TimeoutError:
                            await self.api.request('PUT', f"{root}/items/{item['id']}/progress", headers=headers,
                                json={'projectId': project_id, 'progress': 0, 'errorMessage': '单条成片输出超过 40 分钟，已停止并保留其他成功结果'})
                async with asyncio.TaskGroup() as group:
                    for _ in range(2):
                        group.create_task(consume())
                await self.api.request('POST', f'{root}/finish', headers=headers, json={'projectId': project_id})
            tasks = [asyncio.create_task(heartbeat()), asyncio.create_task(work())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            await message.ack()
        except Exception as exc:
            LOGGER.warning('final output interrupted type=%s', type(exc).__name__)
            await message.nack(requeue=not message.redelivered)
        finally:
            for task in tasks:
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
