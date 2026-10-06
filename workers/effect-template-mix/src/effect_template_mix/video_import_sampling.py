"""Bounded visual evidence for imports; shared montage sampling stays unchanged."""
import asyncio
import logging
import math
import re
from contextlib import suppress
from pathlib import Path

LOGGER = logging.getLogger(__name__)
BASE_FRAME_LIMIT = 40
FRAME_LIMIT = 48
_SAMPLING_SLOTS = asyncio.Semaphore(2)
_NUMBER = r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?"
_CHANGE = re.compile(rf"lavfi\.scd\.score:\s*({_NUMBER}),\s*lavfi\.scd\.time:\s*({_NUMBER})")
_FRAME = re.compile(rf"\bn:\s*(\d+)\s+.*?\bpts_time:\s*({_NUMBER})")


def import_timestamps(duration: float, changes: list[tuple[float, float]]) -> list[float]:
    """changes are (time, pixel-change score), never semantic shot classifications."""
    if not math.isfinite(duration) or not 4 <= duration <= 30:
        raise ValueError("import_duration_invalid")
    end = duration - 0.1  # Stay inside the media, not at its undecodable endpoint.
    count = min(BASE_FRAME_LIMIT, math.ceil(duration * 2) + 1)
    points = [round(end * index / (count - 1), 4) for index in range(count)]
    selected: list[float] = []
    for timestamp, score in sorted(changes, key=lambda item: (-item[1], item[0])):
        if (not math.isfinite(timestamp) or not math.isfinite(score) or score < 10
                or not 0.08 < timestamp < end - 0.02
                or any(abs(timestamp - previous) < 0.12 for previous in selected)):
            continue
        selected.append(timestamp)
        for candidate in (timestamp - 0.08, timestamp + 0.02):
            if all(abs(candidate - point) >= 0.02 for point in points):
                points.append(round(candidate, 4))
        if len(selected) == 4:
            break
    return sorted(points)[:FRAME_LIMIT]


async def _ffmpeg(*arguments: str, timeout: float) -> str:
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info",
        *arguments, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with asyncio.timeout(timeout):
            _, stderr = await process.communicate()
    except (asyncio.CancelledError, TimeoutError):
        if process.returncode is None:
            with suppress(ProcessLookupError):
                process.kill()
            await process.communicate()
        raise
    if process.returncode != 0:
        # Raw FFmpeg diagnostics may contain private filenames. Never propagate them.
        raise RuntimeError("import_frame_processing_failed")
    return stderr.decode("utf-8", errors="replace")


async def sample_import_frames(path: Path, duration: float) -> list[tuple[float, bytes]]:
    # Validate before spawning processes or waiting for a slot.
    timestamps = import_timestamps(duration, [])
    async with _SAMPLING_SLOTS:
        try:
            change_log = await _ffmpeg(
                "-threads", "2", "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
                "-t", str(duration), "-filter_threads", "1", "-vf",
                "setpts=PTS-STARTPTS,scale=320:320:force_original_aspect_ratio=decrease,scdet=threshold=10",
                "-f", "null", "-", timeout=20,
            )
            timestamps = import_timestamps(duration, [
                (float(match[2]), float(match[1])) for match in _CHANGE.finditer(change_log)
            ])
        except (RuntimeError, TimeoutError) as error:
            # Optional supplementation only: a real uniformly sampled video remains valid.
            LOGGER.warning("video_import_scene_sampling_degraded error_type=%s", type(error).__name__)

        # One decoding pass, rather than launching a process for every image.
        expression = "eq(n,0)+" + "+".join(
            f"gte(t,{timestamp})*lt(prev_selected_t,{timestamp})" for timestamp in timestamps[1:]
        )
        pattern = path.with_name(f"{path.stem}-import-%03d.jpg")
        frame_log = await _ffmpeg(
            "-threads", "2", "-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
            "-t", str(duration), "-filter_threads", "1", "-vf",
            f"setpts=PTS-STARTPTS,select='{expression}',"
            "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,showinfo",
            "-fps_mode", "vfr", "-frames:v", str(FRAME_LIMIT), "-threads", "1",
            "-q:v", "4", "-start_number", "0", "-y", str(pattern), timeout=45,
        )
        frames: list[tuple[float, bytes]] = []
        for match in _FRAME.finditer(frame_log):
            index, timestamp = int(match[1]), float(match[2])
            if not 0 <= index < FRAME_LIMIT or not math.isfinite(timestamp) or not 0 <= timestamp < duration:
                raise RuntimeError("import_frame_timestamp_invalid")
            if index != len(frames) or (frames and timestamp <= frames[-1][0]):
                raise RuntimeError("import_frame_order_invalid")
            output = path.with_name(f"{path.stem}-import-{index:03d}.jpg")
            if not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError("import_frame_missing")
            frames.append((timestamp, output.read_bytes()))
        if len(frames) < 2 or frames[0][0] != 0:
            raise RuntimeError("import_frames_incomplete")
        LOGGER.info("video_import_evidence frames=%s", len(frames))
        return frames
