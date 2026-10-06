import copy
import hashlib
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from effect_template_mix.api import InternalApi
from effect_template_mix.final_output import FinalOutputHandler
from effect_template_mix.models import Material
from effect_template_mix.packaging import PackagingHandler, ScriptOutput
from effect_template_mix.packaging_provider import PackagingProvider, PackagingError, TimedVoicePcm
from effect_template_mix.provider import ArkProvider


async def test_normal_or_ready_exports_never_call_trim_or_packaging() -> None:
    api = AsyncMock(spec=InternalApi)
    packaging = AsyncMock(spec=PackagingHandler)
    worker = FinalOutputHandler(api, 1000, packaging=packaging)
    for snapshot in ({'timeline': {}}, {'sourceRefresh': {'ready': True}}):
        assert await worker.prepare_refresh('/run', '/item', {}, 'project', {'snapshot': snapshot}) is snapshot
    packaging.select_source_trims.assert_not_called()
    packaging.process_item.assert_not_called()
    api.request.assert_not_called()


async def test_unexported_refresh_commits_projects_and_never_downloads_or_encodes(monkeypatch: Any) -> None:
    from effect_template_mix import final_output as module
    api = AsyncMock(spec=InternalApi)
    refreshed = {'projectRefreshOnly': True, 'sourceRefresh': {'ready': True}}
    api.request.side_effect = lambda _method, path, **_kwargs: {
        'terminal': False, 'attemptToken': 'token', 'items': [
            {'id': 'changed', 'status': 'QUEUED', 'snapshot': refreshed},
            {'id': 'untouched', 'status': 'PENDING_RENDER', 'snapshot': {}},
        ]} if path.endswith('/claim') else {'accepted': True}
    encoder = AsyncMock()
    monkeypatch.setattr(module, 'render', encoder)
    worker = FinalOutputHandler(api, 1000)
    worker._download = AsyncMock()  # type: ignore[method-assign]
    message = AsyncMock()
    await worker.handle(message, {'projectId': '11111111-1111-4111-8111-111111111111',
        'runId': '22222222-2222-4222-8222-222222222222'})
    calls = [call.args[1] for call in api.request.call_args_list]
    assert any(path.endswith('/changed/complete-source-refresh') for path in calls)
    assert any(path.endswith('/finish') for path in calls)
    assert not any('/untouched/' in path or path.endswith('/video') for path in calls)
    worker._download.assert_not_called()
    encoder.assert_not_called()
    message.ack.assert_awaited_once()


@pytest.mark.parametrize('trims_ready', [False, True])
async def test_prepare_refresh_recovers_saved_steps_and_uses_ready_duration(trims_ready: bool) -> None:
    original = {'sourceRefresh': {'trimsReady': trims_ready, 'slots': [{'slotId': 'a'}]},
                'timeline': {'duration': 10}, 'packaging': {'voices': {}}}
    trimmed = copy.deepcopy(original)
    trimmed['sourceRefresh'].update(trimsReady=True)
    trimmed['timeline'].update(redoSlotIds=['a'], preserveMusic=True)
    ready = {**copy.deepcopy(trimmed), 'sourceRefresh': {'ready': True}, 'timeline': {'duration': 8}}
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'snapshot': trimmed}
    packaging = AsyncMock(spec=PackagingHandler)
    packaging.select_source_trims.return_value = [{'slotId': 'a', 'offset': 5}]
    async def complete(_root: str, _headers: dict[str, str], _project: str, item: dict[str, Any]) -> None:
        item['outputSnapshot'] = ready
    packaging.process_item.side_effect = complete
    worker = FinalOutputHandler(api, 1000, packaging=packaging)
    result = await worker.prepare_refresh('/run', '/item', {}, 'project', {'id': 'i', 'snapshot': original})
    assert result is ready and result['timeline']['duration'] == 8
    assert packaging.select_source_trims.await_count == (0 if trims_ready else 1)
    if not trims_ready:
        assert api.request.call_args.kwargs['json']['trims'] == [{'slotId': 'a', 'offset': 5}]


async def test_missing_refresh_provider_fails_without_fallback_or_paid_work() -> None:
    api = AsyncMock(spec=InternalApi)
    with pytest.raises(PackagingError, match='尚未配置'):
        await FinalOutputHandler(api, 1000).prepare_refresh('/run', '/item', {}, 'project',
            {'snapshot': {'sourceRefresh': {'slots': [{'slotId': 'a'}]}}})
    api.request.assert_not_called()


@pytest.mark.parametrize('with_layout', [False, True])
@pytest.mark.parametrize('deleted_script', [False, True])
async def test_redo_only_changed_slots_preserves_deleted_sibling_audio_captions_and_music(
    monkeypatch: Any, with_layout: bool, deleted_script: bool,
) -> None:
    from effect_template_mix import packaging as module
    api = AsyncMock(spec=InternalApi)
    api.request.return_value = {'fileObjectId': 'new-voice'}
    adapter = AsyncMock(spec=PackagingProvider)
    adapter.voice.return_value = TimedVoicePcm(b'\0\0' * 24000, 0, 24000)
    ark = AsyncMock(spec=ArkProvider)
    row = {'id': 'i', 'stage': 'VISION', 'snapshot': {
        'narrationLayoutVersion': 'SLOT_V1', 'redoSlotIds': ['a'], 'preserveMusic': True,
        'duration': 8, 'variant': {'slots': [{'id': 'a', 'role': 'PRODUCT'}, {'id': 'b', 'role': 'END'}]},
        'clips': [{'slotId': 'a', 'start': 0, 'duration': 4}, {'slotId': 'b', 'start': 4, 'duration': 4}],
        'facts': [{'id': 'f', 'text': '事实'}]}, 'checkpoint': {
        'narrationLayoutVersion': 'SLOT_V1', 'voices': {}, 'musicBrief': '保留描述',
        'vision': [{'slotId': 'b', 'start': 4, 'end': 8, 'description': '原镜头乙'}],
        'script': [{'id': 'b', 'slotId': 'b', 'start': 4, 'end': 8, 'text': '旧口播', 'factIds': ['f']}],
        'captions': [{'id': 'manual', 'manual': True, 'text': '手工标题', 'start': 0, 'end': 3}],
        'captionBoxes': {'manual': {'x': .2, 'y': .5, 'width': .4, 'scale': 2}},
        'music': {'fileObjectId': 'keep-music', 'start': 0, 'duration': 8, 'volume': .2},
    }}
    if with_layout:
        row['checkpoint']['captionLayoutVersion'] = 'SEGMENT_V3'
    # An unaffected clip may have been moved or its narration removed manually. It is not
    # part of the regenerated narration's validation window or missing-script planning.
    row['snapshot']['clips'][1]['start'] = 2
    if deleted_script:
        row['checkpoint']['script'] = []
    baseline = copy.deepcopy(row['checkpoint'])
    selected_visions: list[str] = []
    async def vision(snapshot: dict[str, Any], cp: dict[str, Any], _endpoint: str, _headers: dict[str, str],
                     _project: str, _directory: Any, _guard: Any, save: Any) -> None:
        selected_visions.extend(clip['slotId'] for clip in snapshot['clips'])
        await save('SCRIPT', {'vision': [*cp['vision'], {'slotId': 'a', 'start': 0, 'end': 4, 'description': '新镜头'}]})
    async def plan(_ark: Any, snapshot: dict[str, Any], _vision: Any, _guard: Any, _diagnostics: Any) -> ScriptOutput:
        assert [clip['slotId'] for clip in snapshot['clips']] == ['a']
        return ScriptOutput.model_validate({'lines': [{'id': 'a', 'slotId': 'a', 'start': 0,
            'end': 4, 'text': '新口播', 'factIds': ['f']}], 'musicBrief': '无需改动'})
    monkeypatch.setattr(module, 'plan_script', plan)
    worker = PackagingHandler(api, ark, adapter, 1000)
    worker.slot_vision = vision  # type: ignore[method-assign]
    await worker.process_item('/run', {}, 'project', row)
    cp = row['checkpoint']
    assert selected_visions == ['a']
    adapter.voice.assert_awaited_once_with('新口播', require_timing=True)
    adapter.submit_music.assert_not_called()
    assert cp['music'] == baseline['music'] and cp['captionBoxes'] == baseline['captionBoxes']
    if deleted_script:
        assert len(cp['script']) == 1
    else:
        assert cp['script'][1] == baseline['script'][0]
    assert 'b' not in cp['voices']
    assert not any(caption.get('voiceLineId', caption['id']) == 'b' for caption in cp['captions'])
    assert baseline['captions'][0] in cp['captions']
    assert ('captionLayoutVersion' in cp) == with_layout
    assert row['stage'] == 'READY'


async def test_trim_uses_fresh_source_and_model_offset_instead_of_old_cut(monkeypatch: Any) -> None:
    from effect_template_mix import packaging as module
    data = b'new-source-video'
    client = httpx.AsyncClient(base_url='https://api.test', transport=httpx.MockTransport(lambda _: httpx.Response(200, content=data,
        headers={'x-content-sha256': hashlib.sha256(data).hexdigest()})))
    api = AsyncMock(spec=InternalApi)
    api.client = client
    ark = AsyncMock(spec=ArkProvider)
    ark.trim.return_value = SimpleNamespace(trimStartSeconds=5.5)
    monkeypatch.setattr(module, 'sample_frames', AsyncMock(return_value=[(1.0, b'image')]))
    worker = PackagingHandler(api, ark, AsyncMock(spec=PackagingProvider), 1000)
    material = {'id': 'new', 'code': 'R1', 'name': '新镜头', 'duration': 12, 'sourcePromptId': 'p',
        'artifactId': 'new', 'artifactKey': 'render-clip:new', 'artifactRevision': 2,
        'contentHash': hashlib.sha256(data).hexdigest(), 'fileObjectId': 'new-file', 'promptText': '已确认 Prompt'}
    snapshot = {'variant': {'offsets': {'a': 1}, 'slots': [{'id': 'a', 'role': 'PRODUCT', 'label': '产品', 'duration': 4}]},
        'clips': [{'slotId': 'a', 'prompt': '原始 Prompt'}]}
    try:
        result = await worker.select_source_trims('/run', '/item', {}, 'project', snapshot,
            [{'slotId': 'a', 'material': material}])
        assert result == [{'slotId': 'a', 'offset': 5.5}]
        source: Material = ark.trim.call_args.args[1]
        assert source.fileObjectId == 'new-file' and source.prompt == '已确认 Prompt'
        api.request.assert_awaited_once()
    finally:
        await client.aclose()
