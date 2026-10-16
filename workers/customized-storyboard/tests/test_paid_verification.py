"""Controlled verification of paid-tool isolation and resume; no network calls."""
import json
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace

import pytest
from test_drama_development import DramaProvider, drama_value
from test_typed_creation import draft
from customized_storyboard.typed_creation import TypedDraft
from customized_storyboard.routes import DRAMA_VERSION


def entry(name):
    return runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts' / name))['main']


@pytest.mark.parametrize('name', ['verify_paid_drama_calibration.py', 'verify_paid_creation.py'])
async def test_tools_require_explicit_paid_guard_before_reading_files(monkeypatch, name):
    monkeypatch.delenv('CUSTOMIZED_STORYBOARD_PAID_TEST', raising=False)
    with pytest.raises(RuntimeError, match='Explicit paid authorization required'):
        await entry(name)()


def controlled_provider(monkeypatch, main):
    instances = []
    class Controlled(DramaProvider):
        def __init__(self, *args, **kwargs):
            super().__init__()
            self._client = SimpleNamespace(event_hooks={'response': []})
            instances.append(self)
        async def close(self):
            pass
    monkeypatch.setitem(main.__globals__, 'Provider', Controlled)
    monkeypatch.setenv('CUSTOMIZED_STORYBOARD_PAID_TEST', '1')
    monkeypatch.setenv('ARK_API_KEY', 'test-only-no-network')
    return instances


async def test_blind_calibration_keeps_expectation_offline_and_resumes_without_calls(monkeypatch, tmp_path):
    main = entry('verify_paid_drama_calibration.py')
    instances = controlled_provider(monkeypatch, main)
    case = {'id': 'OFFLINE_CASE_DO_NOT_SEND', 'model': 'controlled', 'brief': {'productName':'测试产品'},
        'story': TypedDraft.model_validate(draft()).story().model_dump(),
        'expected': {'CHARACTER_CAUSALITY': 'FAIL'}}
    source, output = tmp_path / 'cases.json', tmp_path / 'output.json'
    source.write_text(json.dumps([case]), encoding='utf-8')
    monkeypatch.setattr(sys, 'argv', ['calibration', str(source), str(output), '--version=' + DRAMA_VERSION])
    await main()
    assert len(instances[0].calls) == 1
    context = instances[0].contexts[0][2]
    assert 'OFFLINE_CASE_DO_NOT_SEND' not in json.dumps(context)
    assert 'expected' not in context
    state = json.loads(output.read_text('utf-8'))
    assert state['results'][0]['matches'] is False
    assert state['results'][0]['actual']['CHARACTER_CAUSALITY'] == 'PASS'
    await main()
    assert instances[-1].calls == []


async def test_local_model_pipeline_preserves_checkpoint_and_never_writes_remote_api(monkeypatch, tmp_path):
    main = entry('verify_paid_creation.py')
    instances = controlled_provider(monkeypatch, main)
    source, output = tmp_path / 'input.json', tmp_path / 'output.json'
    source.write_text(json.dumps(drama_value()), encoding='utf-8')
    monkeypatch.setattr(sys, 'argv', ['creation', str(source), str(output)])
    await main()
    state = json.loads(output.read_text('utf-8'))
    assert state['complete'] and len(state['scripts']) == 1
    assert len(instances[0].calls) == 5
    await main()
    assert instances[-1].calls == []
    data = drama_value(product='另一个测试产品')
    source.write_text(json.dumps(data), encoding='utf-8')
    with pytest.raises(ValueError, match='Input changed'):
        await main()
