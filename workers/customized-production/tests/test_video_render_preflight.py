from __future__ import annotations

import asyncio
import copy
from typing import Any

import httpx
import pytest
from ai_runtime.responses import ProviderError
from ai_runtime.seedance import SeedanceTransport
from customized_production_runtime import video_render as render
from test_video_render import Api, input_value, shared_parent_input


class Process:
    def __init__(self, status: int | None) -> None:
        self.returncode = status
        self.killed = False
        self.waited = False

    async def communicate(self) -> tuple[bytes, bytes]:
        if self.returncode is None:
            await asyncio.Event().wait()
        return b"", b""

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    async def wait(self) -> int:
        self.waited = True
        assert self.returncode is not None
        return self.returncode


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["ffmpeg", "ffprobe"])
@pytest.mark.parametrize("failure", ["missing", "permission", "nonzero", "timeout"])
async def test_bad_media_tool_blocks_all_provider_work_and_preserves_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
    tool: str,
    failure: str,
) -> None:
    attempted: list[str] = []
    processes: list[Process] = []
    provider_calls: list[str] = []
    original_wait_for = asyncio.wait_for

    async def spawn(name: str, *args: Any, **kwargs: Any) -> Process:
        attempted.append(name)
        assert args == ("-version",)
        assert kwargs == {
            "stdout": asyncio.subprocess.DEVNULL,
            "stderr": asyncio.subprocess.DEVNULL,
        }
        if name == tool and failure in ("missing", "permission"):
            error = FileNotFoundError if failure == "missing" else PermissionError
            raise error("private filesystem diagnostic must not escape")
        process = Process(
            None
            if name == tool and failure == "timeout"
            else 7
            if name == tool and failure == "nonzero"
            else 0
        )
        processes.append(process)
        return process

    async def bounded(awaitable: Any, timeout: float) -> Any:
        assert timeout == 5
        return await original_wait_for(awaitable, timeout=0.01)

    def transport(**kwargs: Any) -> Any:
        provider_calls.append("constructed")
        raise AssertionError("provider must not be constructed before preflight")

    monkeypatch.setattr(render.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(render.asyncio, "wait_for", bounded)
    monkeypatch.setattr(render, "SeedanceTransport", transport)
    for saved in (
        {"unrelatedCheckpoint": {"retained": True}},
        {"providerTaskId": "existing-paid-task", "createStarted": True},
    ):
        claim = {"input": {"videoRender": shared_parent_input()}, "output": saved}
        original = copy.deepcopy(claim)
        api = Api()
        with pytest.raises(ProviderError, match=tool) as raised:
            await render.run_video(api, None, claim)
        assert raised.value.retryable is False
        assert "private filesystem" not in str(raised.value)
        assert claim == original
        assert len(api.calls) == 1
        path, payload = api.calls[0]
        assert path == "checkpoint"
        assert payload["step"]["id"] == "SNAPSHOT"
        assert payload["step"]["status"] == "FAILED"
        assert "output" not in payload
        assert "heartbeat" not in [p for p, _ in api.calls]
    assert provider_calls == []
    assert attempted == (["ffmpeg"] if tool == "ffmpeg" else ["ffmpeg", "ffprobe"]) * 2
    if failure == "timeout":
        assert sum(p.killed and p.waited for p in processes) == 2


@pytest.mark.asyncio
async def test_usable_media_tools_are_checked_without_output_capture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checked: list[str] = []

    async def spawn(name: str, *args: Any, **kwargs: Any) -> Process:
        checked.append(name)
        assert args == ("-version",)
        assert kwargs["stdout"] == kwargs["stderr"] == asyncio.subprocess.DEVNULL
        return Process(0)

    monkeypatch.setattr(render.asyncio, "create_subprocess_exec", spawn)
    await render.ensure_media_tools()
    assert checked == ["ffmpeg", "ffprobe"]


@pytest.mark.asyncio
async def test_preflight_cancellation_reaps_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = Process(None)
    started = asyncio.Event()

    async def spawn(*args: Any, **kwargs: Any) -> Process:
        started.set()
        return process

    monkeypatch.setattr(render.asyncio, "create_subprocess_exec", spawn)
    probe = asyncio.create_task(render.ensure_media_tools())
    await started.wait()
    probe.cancel()
    with pytest.raises(asyncio.CancelledError):
        await probe
    assert process.killed and process.waited


@pytest.mark.asyncio
async def test_original_provider_result_resumes_after_tools_fixed_without_create(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    available = False
    checked: list[str] = []
    requests: list[tuple[str, str]] = []
    uploads: list[bytes] = []
    claim = {
        "input": {"videoRender": input_value()},
        "output": {
            "providerTaskId": "existing-paid-task",
            "createStarted": True,
            "retained": {"version": 1},
        },
    }
    original = copy.deepcopy(claim)

    async def spawn(name: str, *args: Any, **kwargs: Any) -> Process:
        checked.append(name)
        if not available:
            raise FileNotFoundError()
        return Process(0)

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        assert request.method == "GET", "recovery must never POST a provider task"
        if request.url.path.endswith("/tasks/existing-paid-task"):
            return httpx.Response(
                200,
                json={
                    "status": "succeeded",
                    "content": {"video_url": "https://controlled.invalid/result.mp4"},
                },
            )
        assert request.url.path == "/result.mp4"
        return httpx.Response(
            200, content=b"controlled-video", headers={"content-type": "video/mp4"}
        )

    def transport(**kwargs: Any) -> SeedanceTransport:
        return SeedanceTransport(**kwargs, transport=httpx.MockTransport(handle))

    async def poster(video: bytes) -> bytes:
        assert video == b"controlled-video"
        return b"controlled-poster"

    async def upload(api: Any, video: bytes, poster: bytes) -> None:
        assert poster == b"controlled-poster"
        uploads.append(video)

    monkeypatch.setenv("ARK_API_KEY", "controlled-test-only")
    monkeypatch.setattr(render.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(render, "SeedanceTransport", transport)
    monkeypatch.setattr(render, "poster_for", poster)
    monkeypatch.setattr(render, "upload", upload)
    api = Api()
    with pytest.raises(ProviderError, match="ffmpeg"):
        await render.run_video(api, None, claim)
    assert requests == [] and uploads == [] and claim == original
    available = True
    await render.run_video(api, None, claim)
    assert checked == ["ffmpeg", "ffmpeg", "ffprobe"]
    assert [method for method, _ in requests] == ["GET", "GET"]
    assert uploads == [b"controlled-video"]
    assert claim == original
    assert not any(path == "heartbeat" for path, _ in api.calls)
    outputs = [
        payload["output"]
        for path, payload in api.calls
        if path == "checkpoint" and "output" in payload
    ]
    assert outputs and all(output == original["output"] for output in outputs)
