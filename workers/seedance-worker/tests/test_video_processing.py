from __future__ import annotations

from pathlib import Path
from typing import Any

from seedance_worker.models import RenderOutput
from seedance_worker import video_processing


async def test_postprocess_skips_invalid_or_mock_video_bytes() -> None:
    output = RenderOutput(
        provider_task_id="provider-a",
        content=b"mock-video",
        file_name="P001.mp4",
    )

    processed = await video_processing.postprocess_render_output(output)

    assert processed is output
    assert processed.poster is None


async def test_postprocess_uses_faststart_video_and_creates_poster(monkeypatch: Any) -> None:
    calls = 0

    async def fake_run(arguments: list[str]) -> bool:
        nonlocal calls
        calls += 1
        output_path = Path(arguments[-1])
        output_path.write_bytes(b"faststart-video" if calls == 1 else b"jpeg-poster")
        return True

    monkeypatch.setattr(video_processing, "_run_ffmpeg", fake_run)
    output = RenderOutput(
        provider_task_id="provider-a",
        content=b"\x00\x00\x00\x18ftypmp42" + b"video" * 10,
        file_name="P001.mp4",
    )

    processed = await video_processing.postprocess_render_output(output)

    assert processed.content == b"faststart-video"
    assert processed.poster is not None
    assert processed.poster.content == b"jpeg-poster"
    assert processed.poster.file_name == "P001-poster.jpg"
