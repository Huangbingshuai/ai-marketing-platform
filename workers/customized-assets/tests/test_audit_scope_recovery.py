from typing import Any
import pytest
from test_structured_assets import Api, Provider, fixture
from customized_production_runtime.asset_pipeline import run_assets


class ScopeProvider(Provider):
    def __init__(self, fail_correction: bool = False, recheck: bool = False) -> None:
        super().__init__(repair=recheck)
        self.fail_correction = fail_correction
        self.recheck = recheck

    async def generate(self, stage: str, model: str, schema: Any, context: dict[str, Any], instruction: str) -> Any:
        broken_stage = 'ASSET_RECHECK' if self.recheck else 'ASSET_REVIEW'
        if stage in (broken_stage, broken_stage + '_SCOPE'):
            self.calls.append(stage)
            valid_ids = [a['id'] for a in context['assets']]
            assert schema.model_json_schema()['$defs']['Finding']['properties']['assetId']['enum'] == valid_ids
            corrected = stage.endswith('_SCOPE') and not self.fail_correction
            return schema.model_validate({'summary': '引用核对', 'findings': [{
                'assetId': valid_ids[0] if corrected else 'not-an-asset',
                'field': 'description', 'issue': '建议增加外观描述', 'basis': '灰色外壳',
                'severity': 'SUGGESTION',
            }]})
        return await super().generate(stage, model, schema, context, instruction)


@pytest.mark.asyncio
@pytest.mark.parametrize('recheck', [False, True])
async def test_audit_scope_repair_keeps_candidates_and_exact_ids(recheck: bool) -> None:
    claim = fixture()
    api = Api(claim)
    provider = ScopeProvider(recheck=recheck)
    await run_assets(api, provider, claim)  # type: ignore[arg-type]
    key = 'recheck' if recheck else 'audit'
    assert api.completed is not None
    assert claim['output'][key + 'Original']['findings'][0]['assetId'] == 'not-an-asset'
    assert claim['output'][key]['findings'][0]['assetId'] == api.completed['assets'][0]['id']
    assert sum(s.endswith('_SCOPE') for s in provider.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('recheck', [False, True])
async def test_invalid_scope_after_correction_cannot_pay_again_on_resume(recheck: bool) -> None:
    claim = fixture()
    api = Api(claim)
    provider = ScopeProvider(fail_correction=True, recheck=recheck)
    with pytest.raises(ValueError, match='outside asset scope'):
        await run_assets(api, provider, claim)  # type: ignore[arg-type]
    assert api.completed is None
    retry = ScopeProvider(recheck=recheck)
    with pytest.raises(ValueError, match='outside asset scope'):
        await run_assets(api, retry, claim)  # type: ignore[arg-type]
    assert retry.calls == []
    assert api.completed is None
