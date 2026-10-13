"""Export structured asset schemas; tests enforce snapshot consistency."""
import json
from pathlib import Path
from customized_production_runtime.asset_models import Inventory, Definitions, AssetAudit, AssetRepair

root = Path(__file__).resolve().parents[3]
for name, model in [('inventory', Inventory), ('definitions', Definitions), ('review', AssetAudit), ('repair', AssetRepair)]:
    (root / 'packages/contracts/schemas' / f'customized-assets-{name}.schema.json').write_text(
        json.dumps(model.model_json_schema(), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
