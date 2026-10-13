import json
from pathlib import Path
from customized_production_runtime.pipeline import Catalog, ShotList, Prompt, Plan, Audit


def test_deployed_runtime_models_match_contracts() -> None:
    root = Path(__file__).resolve().parents[3]
    for name, model in [('catalog', Catalog), ('shots', ShotList), ('prompt', Prompt), ('plan', Plan), ('audit', Audit)]:
        expected = json.loads((root / 'packages/contracts/schemas' / f'customized-production-{name}.schema.json').read_text(encoding='utf-8'))
        assert model.model_json_schema() == expected
