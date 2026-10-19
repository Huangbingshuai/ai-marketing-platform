import asyncio
import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from ai_runtime.responses import ProviderError
from customized_production_runtime.image_generation import IMAGE_LAYOUTS, ImageSettings, generate_image, image_prompt, run_image

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1kAAAAASUVORK5CYII=')
SETTINGS = {'model': 'doubao-seedream-5-0-pro-260628', 'resolution': '2K', 'ratio': '1:1', 'assetIds': ['product', 'room']}


def test_multi_view_layout_is_shared_with_contracts_and_preserves_custom_prompts() -> None:
    canonical = Path(__file__).resolve().parents[3] / 'packages/contracts/src/customized-asset-image-layout.json'
    assert IMAGE_LAYOUTS == json.loads(canonical.read_text(encoding='utf-8'))
    settings = ImageSettings.model_validate(SETTINGS)
    for kind in ('PRODUCT', 'CHARACTER', 'SCENE', 'PROP'):
        asset = {'id': 'product', 'kind': kind, 'name': '对象', 'description': '实际定义'}
        prompt = image_prompt(asset, {}, settings)
        assert IMAGE_LAYOUTS['common'] in prompt and IMAGE_LAYOUTS[kind] in prompt
        assert '实际定义' in prompt
    customized = ImageSettings.model_validate({**SETTINGS, 'assetIds': ['product'],
        'inputs': [{'assetId': 'product', 'prompt': '人工指定局部特写', 'references': []}]})
    assert image_prompt(asset, {}, customized).startswith('人工指定局部特写\n')
    assert IMAGE_LAYOUTS['common'] not in image_prompt(asset, {}, customized)


def test_custom_inputs_are_scoped_and_reference_versions_are_bounded() -> None:
    item: dict[str, Any] = {'assetId': 'product', 'prompt': '杯子', 'references': [{'assetId': 'b3cc83ca-c891-4b04-b660-9a593a86e1da', 'version': 2}]}
    value = {**SETTINGS, 'assetIds': ['product'], 'inputs': [item]}
    assert ImageSettings.model_validate(value).inputs
    for inputs in ([], [{**item, 'assetId': 'room'}], [{**item, 'prompt': ' '}],
                   [{**item, 'references': item['references'] * 2}],
                   [{**item, 'references': [{'url': 'https://private.invalid'}]}]):
        with pytest.raises(ValueError):
            ImageSettings.model_validate({**value, 'inputs': inputs})


@pytest.mark.asyncio
async def test_reference_images_are_sent_inline_without_remote_url_fetches() -> None:
    references = ['data:image/png;base64,' + base64.b64encode(PNG).decode()]
    def endpoint(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body['image'] == references
        assert body['size'] == '2K'
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(PNG).decode()}]})
    async with httpx.AsyncClient(base_url='https://ark.test/', transport=httpx.MockTransport(endpoint)) as client:
        settings = ImageSettings.model_validate({**SETTINGS, 'ratio': 'auto'})
        assert await generate_image(client, '杯子', settings, references=references) == PNG


@pytest.mark.asyncio
async def test_worker_reads_only_selected_fixed_reference_version(monkeypatch: Any) -> None:
    from customized_production_runtime import image_generation as module
    reference_id = 'b3cc83ca-c891-4b04-b660-9a593a86e1da'
    generated: list[str] = []
    def endpoint(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f'/references/{reference_id}/2'
        assert request.url.params['projectId'] == 'project'
        assert request.headers['x-attempt-token'] == 'controlled-attempt'
        return httpx.Response(200, content=PNG, headers={'content-type': 'image/png'})
    class Provider:
        async def generate_image(self, prompt: str, settings: Any, references: list[str]) -> bytes:
            assert prompt.startswith('暖白釉面杯，柔和侧光')
            assert references == ['data:image/png;base64,' + base64.b64encode(PNG).decode()]
            generated.append(prompt)
            return PNG
    class Api:
        project = 'project'
        token = 'controlled-attempt'
        def __init__(self, client: httpx.AsyncClient) -> None:
            self.client = client
        async def call(self, method: str, path: str, value: Any = None) -> None:
            return None
    async def upload(api: Any, object_id: str, image: bytes) -> None:
        assert object_id == 'product'
    monkeypatch.setattr(module, 'upload_image', upload)
    settings = {**SETTINGS, 'assetIds': ['product'], 'inputs': [{'assetId': 'product',
        'prompt': '暖白釉面杯，柔和侧光', 'references': [{'assetId': reference_id, 'version': 2}]}]}
    async with httpx.AsyncClient(base_url='https://api.test/', transport=httpx.MockTransport(endpoint)) as client:
        await run_image(Api(client), Provider(), {'input': {'imageSettings': settings,
            'document': {'assets': [{'id': 'product', 'kind': 'PRODUCT', 'name': '杯子', 'description': '原定义'}]}}})
    assert len(generated) == 1


def test_contract_matches_pinned_models_and_limits() -> None:
    schema = json.loads((Path(__file__).resolve().parents[3] / 'packages/contracts/schemas/customized-image-settings.schema.json').read_text())
    python = ImageSettings.model_json_schema()
    for field in ('model', 'resolution', 'ratio'):
        assert python['properties'][field]['enum'] == schema['properties'][field]['enum']
    assert python['required'] == schema['required']
    for ids in ([], ['same', 'same'], ['x'] * 21, [' '], ['x' * 201]):
        with pytest.raises(ValueError):
            ImageSettings.model_validate({**SETTINGS, 'assetIds': ids})


@pytest.mark.asyncio
async def test_official_wire_format_and_inline_png_only() -> None:
    async def endpoint(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert request.url.path == '/api/v3/images/generations'
        assert body['model'] == SETTINGS['model'] and body['response_format'] == 'b64_json'
        assert body['size'] == '2048x2048' and body['output_format'] == 'png'
        assert 'sequential_image_generation' not in body
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(PNG).decode()}]})
    async with httpx.AsyncClient(base_url='https://ark.test/api/v3/', transport=httpx.MockTransport(endpoint)) as client:
        assert await generate_image(client, '公共形象', ImageSettings.model_validate(SETTINGS)) == PNG


@pytest.mark.asyncio
@pytest.mark.parametrize('body', [{'data': [{'url': 'http://private.invalid'}]}, {'data': [{'b64_json': 'invalid'}]}, {'data': []}, {'data': [{'error': {'message': 'failed'}}]}])
async def test_invalid_provider_output_is_never_uploaded(body: Any) -> None:
    async with httpx.AsyncClient(base_url='https://ark.test/', transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as client:
        with pytest.raises(ProviderError) as result:
            await generate_image(client, 'image', ImageSettings.model_validate(SETTINGS))
        assert not result.value.retryable


@pytest.mark.asyncio
async def test_uncertain_paid_timeout_is_not_automatically_replayed() -> None:
    calls = 0
    def timeout(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout('timeout', request=request)
    async with httpx.AsyncClient(base_url='https://ark.test/', transport=httpx.MockTransport(timeout)) as client:
        with pytest.raises(ProviderError) as result:
            await generate_image(client, 'image', ImageSettings.model_validate(SETTINGS))
        assert not result.value.retryable and calls == 1


@pytest.mark.asyncio
async def test_rate_limit_has_bounded_retry_without_changing_model(monkeypatch: Any) -> None:
    calls = 0
    async def sleep(delay: float) -> None:
        return None
    monkeypatch.setattr(asyncio, 'sleep', sleep)
    def endpoint(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert json.loads(request.content)['model'] == SETTINGS['model']
        return httpx.Response(429)
    async with httpx.AsyncClient(base_url='https://ark.test/', transport=httpx.MockTransport(endpoint)) as client:
        with pytest.raises(ProviderError) as result:
            await generate_image(client, 'image', ImageSettings.model_validate(SETTINGS))
        assert result.value.retryable and calls == 2


@pytest.mark.asyncio
async def test_resumes_completed_items_and_waits_for_successful_uploads(monkeypatch: Any) -> None:
    from customized_production_runtime import image_generation as module
    generated: list[str] = []
    uploaded: list[str] = []
    calls: list[str] = []
    class Api:
        async def call(self, method: str, path: str, value: Any = None) -> Any:
            calls.append(path)
    class Provider:
        async def generate_image(self, prompt: str, settings: Any) -> bytes:
            generated.append(prompt)
            return PNG
    async def upload(api: Any, object_id: str, image: bytes) -> None:
        uploaded.append(object_id)
    monkeypatch.setattr(module, 'upload_image', upload)
    assets = [{'id': i, 'kind': 'PRODUCT' if i == 'product' else 'SCENE', 'name': i, 'description': '形象'} for i in SETTINGS['assetIds']]
    claim = {'input': {'imageSettings': SETTINGS, 'document': {'assets': assets}, 'brief': {}}, 'output': {'product': {'assetId': 'saved', 'version': 1}}}
    await run_image(Api(), Provider(), claim)
    assert len(generated) == 1 and uploaded == ['room'] and calls[-1] == 'complete'
    prompt = image_prompt(assets[0], {'brandTone': '克制', 'visualConsistencyRules': '暖色', 'avoidedElements': '霓虹灯'}, ImageSettings.model_validate(SETTINGS))
    assert all(text in prompt for text in ('克制', '暖色', '霓虹灯'))


@pytest.mark.asyncio
async def test_partial_failure_retains_other_successes_without_completing(monkeypatch: Any) -> None:
    from customized_production_runtime import image_generation as module
    uploaded: list[str] = []
    calls: list[str] = []
    class Api:
        async def call(self, method: str, path: str, value: Any = None) -> Any:
            calls.append(path)
    class Provider:
        async def generate_image(self, prompt: str, settings: Any) -> bytes:
            if '对象名称：product' in prompt:
                raise ProviderError('rejected', retryable=False)
            await asyncio.sleep(0)
            return PNG
    async def upload(api: Any, object_id: str, image: bytes) -> None:
        uploaded.append(object_id)
    monkeypatch.setattr(module, 'upload_image', upload)
    assets = [{'id': i, 'kind': 'PRODUCT', 'name': i, 'description': '形象'} for i in SETTINGS['assetIds']]
    with pytest.raises(ProviderError):
        await run_image(Api(), Provider(), {'input': {'imageSettings': SETTINGS, 'document': {'assets': assets}}})
    assert uploaded == ['room'] and 'complete' not in calls
