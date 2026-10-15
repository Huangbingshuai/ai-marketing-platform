import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from effect_prompt_generation.models import CreativeDimensions, PromptItem


def test_manual_notes_are_optional_but_ai_structure_remains_required(prompt_item: PromptItem) -> None:
    raw = prompt_item.model_dump(mode="json", by_alias=True)
    raw.update(origin="MANUAL", creativeCore="", dimensions={key: "" for key in raw["dimensions"]})
    raw["dimensions"]["scene"] = "用户只填写场景"
    parsed = PromptItem.model_validate(raw)
    assert parsed.creative_core == ""
    assert parsed.dimensions.scene == "用户只填写场景"
    assert parsed.dimensions.narrative == ""

    schema_path = Path(__file__).resolve().parents[3] / "packages/contracts/schemas/effect-prompt-batch.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator({"$ref": "#/$defs/item", "$defs": schema["$defs"]})
    validator.validate(parsed.model_dump(mode="json", by_alias=True))

    raw["origin"] = "AI"
    with pytest.raises(ValidationError):
        PromptItem.model_validate(raw)
    assert not validator.is_valid(raw)
    with pytest.raises(ValidationError):
        CreativeDimensions.model_validate(raw["dimensions"])
