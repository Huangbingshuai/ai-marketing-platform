from effect_template_mix.models import Material, Slot
from effect_template_mix.provider import classification_payload


def test_models_do_not_accept_upstream_purpose_fields() -> None:
    material = Material.model_validate({
        "id": "m1", "code": "V001", "name": "片段", "duration": 5,
        "promptId": "p1", "prompt": "产品从包装中取出并放到桌面。",
        "artifactId": "m1", "artifactKey": "render-clip:m1", "artifactRevision": 1,
        "contentHash": "a" * 64, "fileObjectId": "f1",
        "primaryPurpose": "HOOK", "compatiblePurposes": ["HOOK"],
    })
    assert "primaryPurpose" not in material.model_dump()
    assert material.prompt.startswith("产品")
    slot = Slot(id="s1", role="HOOK", label="片头钩子", duration=3)
    payload = classification_payload([slot], [material])
    assert payload["materials"] == [{"materialId": "m1", "code": "V001", "prompt": material.prompt}]
    assert "primaryPurpose" not in str(payload)
    assert "compatiblePurposes" not in str(payload)
