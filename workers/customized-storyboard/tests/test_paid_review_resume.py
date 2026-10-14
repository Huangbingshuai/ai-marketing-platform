"""The local paid audit runner must not repurchase a persisted successful sub-audit."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

from customized_storyboard.typed_creation import TypedDraft
from test_typed_creation import Provider as ControlledProvider, draft, value


@pytest.mark.asyncio
async def test_local_review_restores_fact_checkpoint_without_network(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[1] / 'scripts' / 'verify_paid_typed_review.py'
    spec = importlib.util.spec_from_file_location('local_paid_review', script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    roles = []

    class Provider(ControlledProvider):
        def __init__(self, *args, **kwargs):
            super().__init__('BRAND_AD')

        async def generate(self, stage, model, schema, context, instruction):
            roles.append(context.get('auditRole'))
            return await super().generate(stage, model, schema, context, instruction)

        async def close(self):
            pass

    story = TypedDraft.model_validate(draft()).story()
    fixture = {'input': value(), 'story': story.model_dump()}
    source, destination = tmp_path / 'input.json', tmp_path / 'result.json'
    source.write_text(json.dumps(fixture), 'utf-8')
    fingerprint = hashlib.sha256(json.dumps([fixture, 'configured'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    destination.write_text(json.dumps({
        'fingerprint': fingerprint, 'calls': [], 'failure': 'ProviderError',
        'checkpoint': {'nodeId': 'BRAND_AD_REVIEW', 'scriptId': 's0', 'status': 'RUNNING',
            'output': {'bodyHash': hashlib.sha256(story.model_dump_json().encode()).hexdigest(),
                'factReview': {'summary': '已完成事实核查', 'findings': []}}},
    }), 'utf-8')
    monkeypatch.setattr(module, 'Provider', Provider)
    monkeypatch.setattr(module.sys, 'argv', [str(script), str(source), str(destination), 'configured'])
    monkeypatch.setenv('CUSTOMIZED_STORYBOARD_PAID_TEST', '1')
    monkeypatch.setenv('ARK_API_KEY', 'test-not-a-real-key')
    await module.main()
    assert roles == ['EDITORIAL']
    restored = json.loads(destination.read_text('utf-8'))
    assert restored['result']['qualityChecks']
    assert restored['recoveredFailure'] == 'ProviderError'
    assert 'failure' not in restored
    await module.main()
    assert roles == ['EDITORIAL']
