from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path

from .models import RenderOutput, RenderPoster


LOGGER = logging.getLogger(__name__)
_POSTER_WIDTH = 480
_FFMPEG_TIMEOUT_SECONDS = 60.0


async def _run_ffmpeg(arguments: list[str]) -> bool:
    try:
        process = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *arguments,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return False
    try:
        await asyncio.wait_for(process.communicate(), timeout=_FFMPEG_TIMEOUT_SECONDS)
    except TimeoutError:
        process.kill()
        await process.communicate()
        return False
    return process.returncode == 0


async def postprocess_render_output(output: RenderOutput) -> RenderOutput:
    """Create a fast-start MP4 and lightweight poster without risking the video result."""
    if (
        output.mime_type.casefold() != "video/mp4"
        or len(output.content) <= 32
        or b"ftyp" not in output.content[:32]
    ):
        return output

    try:
        with tempfile.TemporaryDirectory(prefix="seedance-video-") as temporary:
            root = Path(temporary)
            source_path = root / "source.mp4"
            normalized_path = root / "faststart.mp4"
            poster_path = root / "poster.jpg"
            await asyncio.to_thread(source_path.write_bytes, output.content)

            normalized = await _run_ffmpeg(
                [
                    "-i",
                    str(source_path),
                    "-map",
                    "0",
                    "-c",
                    "copy",
                    "-movflags",
                    "+faststart",
                    str(normalized_path),
                ]
            )
            video_path = normalized_path if normalized and normalized_path.is_file() else source_path
            content = (
                await asyncio.to_thread(normalized_path.read_bytes)
                if video_path == normalized_path
                else output.content
            )

            poster_created = await _run_ffmpeg(
                [
                    "-ss",
                    "0.5",
                    "-i",
                    str(video_path),
                    "-map",
                    "0:v:0",
                    "-frames:v",
                    "1",
                    "-vf",
                    f"scale={_POSTER_WIDTH}:-2:flags=lanczos",
                    "-q:v",
                    "5",
                    "-an",
                    str(poster_path),
                ]
            )
            poster = None
            if poster_created and poster_path.is_file() and poster_path.stat().st_size > 0:
                poster = RenderPoster(
                    content=await asyncio.to_thread(poster_path.read_bytes),
                    file_name=Path(output.file_name).stem + "-poster.jpg",
                )
            return output.model_copy(update={"content": content, "poster": poster})
    except Exception as exc:
        LOGGER.warning("video post-processing skipped error=%s", type(exc).__name__)
        return output
