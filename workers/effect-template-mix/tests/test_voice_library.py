import asyncio
import base64
import json
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4
from pathlib import Path

import httpx
import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.packaging import narration_windows, plan_script
from effect_template_mix.packaging_provider import PackagingError, PackagingProvider, PackagingTransientError, VoicePermissionError
from effect_template_mix.provider import ArkProvider
from effect_template_mix.voice_preview import VoicePreviewHandler, VoicePreviewMessage
from test_packaging import plan_result, script_snapshot, item
from effect_template_mix.packaging import PackagingHandler
from effect_template_mix.consumer import Consumer


def test_queue_model_matches_shared_contract_schema() -> None:
    contract = Path(__file__).resolve().parents[3] / 'packages/contracts/schemas/effect-voice-preview-message.schema.json'
    shared = json.loads(contract.read_text(encoding='utf-8'))
    model = VoicePreviewMessage.model_json_schema()
    assert set(model['required']) == set(shared['required'])
    assert model['additionalProperties'] is shared['additionalProperties'] is False
    for name, schema in shared['properties'].items():
        for key, value in schema.items():
            assert model['properties'][name][key] == value


@pytest.mark.parametrize('role', ['HOOK', 'END', 'PRODUCT'])
@pytest.mark.parametrize('duration', [3, 6, 10, 15])
def test_budgets_follow_duration_even_for_long_hooks(role: str, duration: float) -> None:
    snapshot = script_snapshot()
    snapshot['variant']['slots'][0]['role'] = role
    snapshot['clips'][0]['duration'] = snapshot['duration'] = duration
    row = narration_windows(snapshot)[0]
    assert 0 < row['minCharacters'] <= row['targetCharacters'] <= row['maxCharacters']
    if duration == 15:
        assert row['minCharacters'] > 15 and row['targetCharacters'] >= 30
    if duration == 3:
        assert row['minCharacters'] == 1


async def test_short_long_slot_text_repairs_once_then_rejects() -> None:
    ark = AsyncMock(spec=ArkProvider)
    ark.structured.side_effect = [plan_result(text='太短'), plan_result()]
    result = await plan_script(ark, script_snapshot(), [], AsyncMock())
    assert len(result.lines[0].text) > 15
    assert ark.structured.await_count == 2
    ark.structured.side_effect = [plan_result(text='太短'), plan_result(text='仍短')]
    with pytest.raises(PackagingError):
        await plan_script(ark, script_snapshot(), [], AsyncMock())


def preview_harness(error: Exception | None = None) -> tuple[Any, ...]:
    api = AsyncMock(spec=InternalApi)
    api.ROOT = '/internal/workers/effect-template-mix'
    api.request.side_effect = lambda method, url, **kw: {
        'terminal': False, 'attemptToken': 'token',
        'snapshot': {'profile': {'speaker': 'frozen_voice', 'resourceId': 'seed-tts-2.0'}, 'sampleText': '固定试听文案'},
    } if url.endswith('/claim') else {'accepted': True}
    provider = AsyncMock(spec=PackagingProvider)
    provider.require_tts_configuration = lambda: None
    provider.voice.return_value = b'\x01\x00' * 24000
    if error:
        provider.voice.side_effect = error
    message = AsyncMock()
    message.redelivered = False
    envelope = {'schemaVersion': 2, 'taskType': 'VOICE_PREVIEW', 'projectId': str(uuid4()), 'runId': str(uuid4()), 'requestId': str(uuid4())}
    handler = VoicePreviewHandler(api, provider, asyncio.Semaphore(4))
    return api, provider, message, envelope, handler


async def test_preview_fences_paid_call_and_uploads_real_wav_once() -> None:
    api, provider, message, envelope, handler = preview_harness()
    await handler.handle(message, envelope)
    paths = [call.args[1].rsplit('/', 1)[-1] for call in api.request.call_args_list]
    assert paths == ['claim', 'submit', 'audio']
    provider.voice.assert_awaited_once_with('固定试听文案', speaker='frozen_voice', resource_id='seed-tts-2.0')
    wav = api.request.call_args_list[-1].kwargs['files']['file'][1]
    assert wav[:4] == b'RIFF'
    message.ack.assert_awaited_once()


@pytest.mark.parametrize(('error', 'code'), [
    (VoicePermissionError('safe'), 'UNAUTHORIZED'),
    (PackagingTransientError('safe'), 'SUBMISSION_UNKNOWN'),
    (httpx.ReadTimeout('timeout'), 'SUBMISSION_UNKNOWN'),
    (PackagingError('safe'), 'PROVIDER_REJECTED'),
])
async def test_preview_never_repeats_unknown_paid_submission(error: Exception, code: str) -> None:
    api, provider, message, envelope, handler = preview_harness(error)
    await handler.handle(message, envelope)
    assert provider.voice.await_count == 1
    assert api.request.call_args_list[-1].kwargs['json']['code'] == code
    message.ack.assert_awaited_once()


async def test_terminal_or_malformed_preview_never_calls_provider() -> None:
    api, provider, message, envelope, handler = preview_harness()
    api.request.side_effect = None
    api.request.return_value = {'terminal': True}
    await handler.handle(message, envelope)
    await handler.handle(message, {**envelope, 'taskType': 'OTHER'})
    assert provider.voice.await_count == 0 and api.request.await_count == 1


async def test_selected_voice_uses_snapshot_not_current_provider_default() -> None:
    def response(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)['req_params']['speaker'] == 'frozen_voice'
        assert request.headers['X-Api-Resource-Id'] == 'seed-tts-2.0'
        return httpx.Response(200, text='data: ' + json.dumps({'code': 0, 'data': base64.b64encode(b'\x01\x00' * 24000).decode()}) + '\n\ndata: {"code":20000000}\n')
    client = httpx.AsyncClient(transport=httpx.MockTransport(response))
    provider = PackagingProvider('test-key', 'new_default', 'seed-tts-1.0', '', '', 'GenBGMForTime', client)
    provider.require_tts_configuration()  # no music credentials needed for audition
    assert len(await provider.voice('测试', speaker='frozen_voice', resource_id='seed-tts-2.0')) == 48000
    await provider.close()


async def test_packaging_persists_frozen_voice_and_real_utilization() -> None:
    value = item()
    value['snapshot']['voiceProfile'] = {'id': 'selected', 'speaker': 'frozen_voice', 'resourceId': 'seed-tts-2.0'}
    api, ark, provider = AsyncMock(spec=InternalApi), AsyncMock(spec=ArkProvider), AsyncMock(spec=PackagingProvider)
    api.request.return_value = {'fileObjectId': 'saved'}
    provider.voice.return_value = b'\x01\x00' * 24000
    handler = PackagingHandler(api, ark, provider, 1000)
    await handler.process_item('/run', {}, 'project', value)
    provider.voice.assert_awaited_once_with(value['checkpoint']['script'][0]['text'], speaker='frozen_voice', resource_id='seed-tts-2.0')
    cp = value['checkpoint']
    slot = cp['script'][0]['slotId']
    assert cp['narrationMetrics'][slot]['audioSeconds'] == 1
    assert cp['narrationMetrics'][slot]['utilization'] == 1 / cp['narrationMetrics'][slot]['slotSeconds']
    assert next(iter(cp['voices'].values()))['voiceProfile']['id'] == 'selected'
    del cp['narrationMetrics']  # recover upload-before-checkpoint crash without generating again
    await handler.process_item('/run', {}, 'project', value)
    assert provider.voice.await_count == 1 and cp['narrationMetrics'][slot]['audioSeconds'] == 1


async def test_preview_runs_during_packaging_but_waits_for_shared_vendor_permit() -> None:
    api, provider, message, envelope, handler = preview_harness()
    entered, release, claimed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    packaging = AsyncMock(spec=PackagingHandler)
    packaging.requests = handler.requests
    async def long_job(*_: Any) -> None:
        for _ in range(4):
            await handler.requests.acquire()
        entered.set()
        await release.wait()
        for _ in range(3):
            handler.requests.release()
    packaging.handle.side_effect = long_job
    response = api.request.side_effect
    def request(method: str, url: str, **kwargs: Any) -> Any:
        if url.endswith('/claim'):
            claimed.set()
        return response(method, url, **kwargs)
    api.request.side_effect = request
    consumer = Consumer('amqp://test', 'effect.template-mix.requested', api, AsyncMock(spec=ArkProvider),
        1000, 10, 16000, 8192, 4, packaging, None, handler)
    long_message = AsyncMock()
    long_message.body = json.dumps({**envelope, 'taskType': 'PACKAGING'}).encode()
    message.body = json.dumps(envelope).encode()
    long_task = asyncio.create_task(consumer.handle(long_message))
    await asyncio.wait_for(entered.wait(), 1)
    preview_task = asyncio.create_task(consumer.handle(message))
    try:
        await asyncio.wait_for(claimed.wait(), 1)
        assert provider.voice.await_count == 0
        handler.requests.release()  # one packaging call finishes, while its Run stays active
        await asyncio.wait_for(preview_task, 1)
        assert provider.voice.await_count == 1 and not long_task.done()
    finally:
        release.set()
        await long_task
