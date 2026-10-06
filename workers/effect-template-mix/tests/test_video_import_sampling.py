import asyncio
import json
import shutil
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from effect_template_mix.video_import_sampling import FRAME_LIMIT, _ffmpeg, import_timestamps, sample_import_frames


@pytest.mark.parametrize("duration", [4, 6.04, 15.041667, 30])
def test_import_samples_keep_start_end_and_bounded_two_fps(duration: float) -> None:
    values = import_timestamps(duration, [])
    assert values[0] == 0
    assert values[-1] == pytest.approx(duration - 0.1, abs=0.0001)
    assert values == sorted(set(values))
    assert 9 <= len(values) <= 40
    assert all(0 <= value < duration for value in values)
    if duration > 6:
        assert len(values) > 12


def test_changes_keep_before_after_evidence_and_total_budget() -> None:
    changes = [(index / 10, float(40 + index % 5)) for index in range(1, 300)]
    values = import_timestamps(30, changes)
    assert len(values) <= FRAME_LIMIT
    assert values[0] == 0 and values[-1] == 29.9
    values = import_timestamps(15, [(2.12, 90), (2.36, 80), (4.19, 70), (7.12, 60), (11.12, 50)])
    for value in (2.04, 2.14, 2.28, 2.38, 4.11, 4.21, 7.04, 7.14):
        assert any(abs(point - value) <= 0.02 for point in values)
    assert 11.04 not in values  # Only four strongest separated candidates are added.


def test_bad_changes_do_not_replace_real_uniform_evidence() -> None:
    invalid = [(float("nan"), 80), (3, float("inf")), (-2, 99), (30, 90), (2, 9)]
    assert import_timestamps(15, invalid) == import_timestamps(15, [])


@pytest.mark.parametrize("duration", [3.99, 30.01, float("nan"), float("inf")])
async def test_invalid_duration_never_spawns_ffmpeg(duration: float, monkeypatch: pytest.MonkeyPatch) -> None:
    runner = AsyncMock()
    monkeypatch.setattr("effect_template_mix.video_import_sampling._ffmpeg", runner)
    with pytest.raises(ValueError, match="import_duration_invalid"):
        await sample_import_frames(Path("private.mp4"), duration)
    runner.assert_not_awaited()


async def test_detection_failure_degrades_without_disclosing_diagnostics(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    path = tmp_path / "private.mp4"
    (tmp_path / "private-import-000.jpg").write_bytes(b"first")
    (tmp_path / "private-import-001.jpg").write_bytes(b"last")
    runner = AsyncMock(side_effect=[RuntimeError("secret-signed-url"), "[showinfo] n: 0 pts: 0 pts_time:0\n[showinfo] n: 1 pts: 100 pts_time:5.9"])
    monkeypatch.setattr("effect_template_mix.video_import_sampling._ffmpeg", runner)
    assert await sample_import_frames(path, 6) == [(0, b"first"), (5.9, b"last")]
    assert "degraded" in caplog.text and "secret" not in caplog.text and "private" not in caplog.text
    assert runner.await_count == 2


@pytest.mark.parametrize("log,code", [
    ("", "import_frames_incomplete"),
    ("[showinfo] n: 0 pts: 0 pts_time:30", "import_frame_timestamp_invalid"),
    ("[showinfo] n: 1 pts: 0 pts_time:0", "import_frame_order_invalid"),
    ("[showinfo] n: 0 pts: 0 pts_time:0", "import_frame_missing"),
])
async def test_missing_or_invalid_real_evidence_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, log: str, code: str) -> None:
    monkeypatch.setattr("effect_template_mix.video_import_sampling._ffmpeg", AsyncMock(side_effect=["", log]))
    with pytest.raises(RuntimeError, match=code):
        await sample_import_frames(tmp_path / "video.mp4", 6)


@pytest.mark.parametrize("timeout", [False, True])
async def test_cancel_or_timeout_kills_and_reaps_child(monkeypatch: pytest.MonkeyPatch, timeout: bool) -> None:
    started, stopped = asyncio.Event(), asyncio.Event()

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
    monkeypatch.setattr("effect_template_mix.video_import_sampling.asyncio.create_subprocess_exec", AsyncMock(return_value=process))
    task = asyncio.create_task(_ffmpeg("-version", timeout=0.01 if timeout else 30))
    await started.wait()
    if not timeout:
        task.cancel()
    with pytest.raises(TimeoutError if timeout else asyncio.CancelledError):
        await task
    assert process.killed and stopped.is_set()


async def test_process_errors_never_expose_source_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    process = AsyncMock(returncode=1)
    process.communicate.return_value = (b"", b"private-source token=secret")
    monkeypatch.setattr("effect_template_mix.video_import_sampling.asyncio.create_subprocess_exec", AsyncMock(return_value=process))
    with pytest.raises(RuntimeError, match="^import_frame_processing_failed$"):
        await _ffmpeg("-version", timeout=1)


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="FFmpeg required")
@pytest.mark.parametrize("size", ["320x180", "180x320", "1080x1920"])
async def test_real_ffmpeg_captures_quick_insert_and_exact_evidence_times(tmp_path: Path, size: str) -> None:
    video = tmp_path / "insert.mp4"
    # A 0.24-second insert falls between two baseline samples. Local test media only.
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
        f"color=black:s={size}:r=25:d=6,drawbox=color=white:t=fill:enable='between(t,2.12,2.32)'",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(video),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, error = await process.communicate()
    assert process.returncode == 0, error.decode()
    frames = await sample_import_frames(video, 6)
    assert frames[0][0] == 0
    assert frames[-1][0] >= 5.9
    assert len(frames) <= FRAME_LIMIT
    assert all(frames[index][0] < frames[index + 1][0] for index in range(len(frames) - 1))
    assert any(2.12 <= timestamp <= 2.32 for timestamp, _ in frames)
    assert any(2.02 <= timestamp < 2.12 for timestamp, _ in frames)
    assert all(data.startswith(b"\xff\xd8") for _, data in frames)
    probe = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "json",
        str(tmp_path / "insert-import-000.jpg"), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    output, _ = await probe.communicate()
    dimensions = json.loads(output)["streams"][0]
    width, height = map(int, size.split("x"))
    assert max(dimensions.values()) <= 768
    if max(width, height) <= 768:
        assert dimensions == {"width": width, "height": height}
    else:
        assert dimensions == {"width": 432, "height": 768}


async def test_five_imports_have_bounded_processing_and_isolated_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    active = peak = 0
    async def runner(*arguments: str, timeout: float) -> str:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.005)
            if arguments[-1] == "-":
                return ""
            pattern = Path(arguments[-1])
            for index in range(2):
                Path(str(pattern).replace("%03d", f"{index:03d}")).write_bytes(pattern.parent.name.encode())
            return "[showinfo] n: 0 pts: 0 pts_time:0\n[showinfo] n: 1 pts: 100 pts_time:5.9"
        finally:
            active -= 1
    monkeypatch.setattr("effect_template_mix.video_import_sampling._ffmpeg", runner)
    monkeypatch.setattr("effect_template_mix.video_import_sampling._SAMPLING_SLOTS", asyncio.Semaphore(2))
    paths = [tmp_path / str(index) / "video.mp4" for index in range(5)]
    for path in paths:
        path.parent.mkdir()
    results = await asyncio.gather(*(sample_import_frames(path, 6) for path in paths))
    assert peak == 2
    assert [frames[0][1] for frames in results] == [str(index).encode() for index in range(5)]
