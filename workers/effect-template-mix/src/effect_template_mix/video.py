import asyncio
from pathlib import Path


def uniform_timestamps(duration: float, count: int = 12) -> list[float]:
    frame_count = max(1, min(count, 12))
    return [round(duration * (index + 0.5) / frame_count, 3) for index in range(frame_count)]


async def sample_frames(path: Path, duration: float, count: int = 12) -> list[tuple[float, bytes]]:
    timestamps = uniform_timestamps(duration, count)

    async def extract(index: int, timestamp: float) -> tuple[float, bytes]:
        output = path.with_name(f"frame-{index:02d}.jpg")
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path),
            "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", "-y", str(output),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        _, error = await process.communicate()
        if process.returncode != 0 or not output.exists():
            raise RuntimeError("FFmpeg 抽帧失败：" + error.decode("utf-8", errors="ignore")[:120])
        return timestamp, output.read_bytes()

    return [await extract(index, timestamp) for index, timestamp in enumerate(timestamps)]
