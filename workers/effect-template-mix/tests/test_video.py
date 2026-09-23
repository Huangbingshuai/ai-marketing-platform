import asyncio
from pathlib import Path

import pytest

from effect_template_mix.video import uniform_timestamps
from effect_template_mix.video import sample_frames


def test_uniform_timestamps_are_bounded_and_capped_at_twelve() -> None:
    values = uniform_timestamps(6, 99)
    assert len(values) == 12
    assert values[0] == 0.25
    assert values[-1] == 5.75
    assert all(0 <= value < 6 for value in values)


@pytest.mark.asyncio
async def test_concurrent_materials_use_distinct_frame_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    outputs: list[Path] = []

    class Process:
        returncode = 0

        async def communicate(self) -> tuple[bytes, bytes]:
            return b"", b""

    async def start(*args: str, **_kwargs: object) -> Process:
        output = Path(args[-1])
        outputs.append(output)
        output.write_bytes(output.name.encode())
        return Process()

    monkeypatch.setattr("effect_template_mix.video.asyncio.create_subprocess_exec", start)
    first, second = await asyncio.gather(
        sample_frames(tmp_path / "variant-01.mp4", 4, count=2),
        sample_frames(tmp_path / "variant-02.mp4", 4, count=2),
    )

    assert len(outputs) == len(set(outputs)) == 4
    assert first[0][1] != second[0][1]


@pytest.mark.asyncio
async def test_cancelled_sampling_kills_and_reaps_ffmpeg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    started = asyncio.Event()
    stopped = asyncio.Event()

    class Process:
        returncode: int | None = None
        killed = False

        async def communicate(self) -> tuple[bytes, bytes]:
            started.set()
            await stopped.wait()
            return b"", b""

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9
            stopped.set()

    process = Process()

    async def start(*_args: str, **_kwargs: object) -> Process:
        return process

    monkeypatch.setattr("effect_template_mix.video.asyncio.create_subprocess_exec", start)
    task = asyncio.create_task(sample_frames(tmp_path / "variant.mp4", 4, count=1))
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert process.killed
