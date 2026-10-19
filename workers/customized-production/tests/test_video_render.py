from typing import Any
import pytest
from ai_runtime.responses import ProviderError
from customized_production_runtime import video_render as render
from pathlib import Path
import json


def input_value() -> dict[str, Any]:
    return {'settings': {'capabilityKey': 'SEEDANCE_2_0', 'ratio': '16:9', 'resolution': '720p'}, 'model': 'controlled', 'clipId': 'clip', 'title': '杯', 'seconds': 6, 'prompt': '0–6秒：杯的特写。', 'references': []}


def test_render_input_contract_schema_matches_python() -> None:
    schema = Path(__file__).resolve().parents[3] / 'packages/contracts/schemas/customized-video-render-input-v1.schema.json'
    assert render.RenderInput.model_json_schema() == json.loads(schema.read_text(encoding='utf-8'))


def test_numbered_reference_compilation_keeps_original_text() -> None:
    value = input_value()
    value['prompt'] = '@杯托旁的@杯；再次@杯托。'
    value['references'] = [{'objectId': name, 'name': name, 'assetId': name, 'version': 1, 'storageKey': name, 'mimeType': 'image/png', 'sizeBytes': 10, 'sha256': 'a' * 64} for name in ['杯', '杯托']]
    parsed = render.RenderInput.model_validate(value)
    text = render.render_text(parsed)
    assert '图片2旁的图片1；再次图片2。' in text
    assert parsed.prompt == value['prompt']
    assert 'storageKey' not in text
    assert '多视角是同一实体的不同角度' in text
    assert '不从场景图额外带入正文未要求的商品、道具或人物' in text
    assert render.render_text(render.RenderInput.model_validate(input_value())) == input_value()['prompt']


class Api:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def call(self, method: str, path: str, value: Any = None) -> dict[str, Any]:
        self.calls.append((path, value))
        return {}


@pytest.mark.asyncio
async def test_uncertain_creation_does_not_call_provider() -> None:
    api = Api()
    with pytest.raises(ProviderError, match='结果未知'):
        await render.run_video(api, None, {'input': {'videoRender': input_value()}, 'output': {'createStarted': True}})
    assert not api.calls


@pytest.mark.asyncio
async def test_saved_provider_id_resumes_without_reloading_or_recreating_images(monkeypatch: pytest.MonkeyPatch) -> None:
    api = Api()
    seen: list[str | None] = []
    class Transport:
        def __init__(self, **kwargs: Any) -> None:
            pass
        async def render_request(self, payload: Any, file_name: str, progress: Any, provider_task_id: str | None = None) -> Any:
            seen.append(provider_task_id)
            await progress(92, provider_task_id)
            return type('Output', (), {'content': b'video'})()
        async def aclose(self) -> None:
            pass
    async def poster(video: bytes) -> bytes:
        return b'poster'
    uploads: list[bytes] = []
    async def upload(api: Any, video: bytes, poster: bytes) -> None:
        uploads.append(video)
    monkeypatch.setenv('ARK_API_KEY', 'controlled-test-only')
    monkeypatch.setattr(render, 'SeedanceTransport', Transport)
    monkeypatch.setattr(render, 'poster_for', poster)
    monkeypatch.setattr(render, 'upload', upload)
    await render.run_video(api, None, {'input': {'videoRender': input_value()}, 'output': {'providerTaskId': 'already-created', 'createStarted': True}})
    assert seen == ['already-created']
    assert uploads == [b'video']
    assert all(path != 'heartbeat' for path, _ in api.calls)
@pytest.mark.asyncio
@pytest.mark.parametrize(('code', 'expected'), [('SEEDANCE_HTTP_401', 'createRejected'), ('SEEDANCE_HTTP_429', 'rateLimited'), ('SEEDANCE_CREATE_RESULT_UNKNOWN', 'createStarted')])
async def test_create_rejection_and_uncertainty_keep_distinct_fences(monkeypatch: pytest.MonkeyPatch, code: str, expected: str) -> None:
    api = Api()
    class Transport:
        def __init__(self, **kwargs: Any) -> None:
            pass
        async def render_request(self, *args: Any) -> Any:
            raise render.VideoProviderError(code, 'controlled failure', retryable=code.endswith('429'))
        async def aclose(self) -> None:
            pass
    monkeypatch.setenv('ARK_API_KEY', 'controlled-test-only')
    monkeypatch.setattr(render, 'SeedanceTransport', Transport)
    with pytest.raises(ProviderError):
        await render.run_video(api, None, {'input': {'videoRender': input_value()}})
    outputs = [value['output'] for path, value in api.calls if path == 'checkpoint' and value and 'output' in value]
    assert outputs[-1][expected] is True
    assert outputs[-1]['createStarted'] is (expected == 'createStarted')
