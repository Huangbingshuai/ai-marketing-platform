import json
from pathlib import Path
from pydantic import BaseModel
from customized_production_runtime.pipeline import Catalog, ShotList, Prompt, Plan, Audit
from customized_production_runtime.asset_models import Inventory, Definitions, AssetAudit, AssetRepair


def test_deployed_runtime_models_match_contracts() -> None:
    root = Path(__file__).resolve().parents[3]
    models: list[tuple[str, type[BaseModel]]] = [('catalog', Catalog), ('shots', ShotList), ('prompt', Prompt), ('plan', Plan), ('audit', Audit)]
    for name, model in models:
        expected = json.loads((root / 'packages/contracts/schemas' / f'customized-production-{name}.schema.json').read_text(encoding='utf-8'))
        assert model.model_json_schema() == expected


def test_structured_asset_contract_schemas() -> None:
    root = Path(__file__).resolve().parents[3]
    models: list[tuple[str, type[BaseModel]]] = [('inventory', Inventory), ('definitions', Definitions), ('review', AssetAudit), ('repair', AssetRepair)]
    for name, model in models:
        expected = json.loads((root / 'packages/contracts/schemas' / f'customized-assets-{name}.schema.json').read_text(encoding='utf-8'))
        assert model.model_json_schema() == expected
