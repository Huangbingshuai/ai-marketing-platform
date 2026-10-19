from __future__ import annotations
import json
from pathlib import Path
from typing import Any
import pytest
from customized_production_runtime.asset_image_source import image_source
from customized_production_runtime import image_generation as module


def fixture() -> dict[str, Any]:
    return json.loads(
        (
            Path(__file__).resolve().parents[3]
            / "packages/contracts/fixtures/customized-asset-image-ownership.json"
        ).read_text(encoding="utf-8")
    )  # type: ignore[no-any-return]


def test_shared_ownership_fixture_and_legacy_compatibility() -> None:
    value = fixture()
    assets = value["assets"]
    for id, parent in value["detailParents"].items():
        assert image_source(assets, id)["id"] == parent
    for id in value["eligibleIds"]:
        assert image_source(assets, id)["id"] == id
    del assets[0]["preparation"]
    assert image_source(assets, "detail-a")["id"] == "room-a"
    assets[10]["image"] = {"assetId": "old-child", "version": 1}
    assert image_source(assets, "detail-a")["id"] == "room-a"


@pytest.mark.parametrize(
    "broken",
    [
        "missing",
        "other-run",
        "wrong-kind",
        "cycle",
        "self",
        "duplicate",
        "invalid-independent",
    ],
)
def test_invalid_ownership_never_searches_other_catalogs(broken: str) -> None:
    a = fixture()["assets"]
    if broken in ("missing", "other-run"):
        a.pop(0)
    if broken == "wrong-kind":
        a[0]["kind"] = "PROP"
    if broken == "cycle":
        a[0]["preparation"].update(treatment="SCENE_DETAIL", parentId="room-b")
        a[1]["preparation"].update(treatment="SCENE_DETAIL", parentId="room-a")
    if broken == "self":
        a[0]["preparation"].update(treatment="SCENE_DETAIL", parentId="room-a")
    if broken == "duplicate":
        a.append(a[0].copy())
    if broken == "invalid-independent":
        a[0]["preparation"]["parentId"] = "room-b"
    with pytest.raises(ValueError):
        image_source(a, "detail-a")


@pytest.mark.asyncio
@pytest.mark.parametrize("mixed", [True, False])
async def test_explicit_detail_selection_fails_before_any_model_or_api_call(
    mixed: bool,
) -> None:
    value = fixture()

    class Never:
        def __getattr__(self, name: str) -> Any:
            raise AssertionError(f"unexpected call {name}")

    ids = value["eligibleIds"] + ["detail-a"] if mixed else ["detail-a"]
    settings = {
        "model": "doubao-seedream-5-0-pro-260628",
        "resolution": "2K",
        "ratio": "1:1",
        "assetIds": ids,
    }
    with pytest.raises(ValueError, match="parent image"):
        await module.run_image(
            Never(),
            Never(),
            {
                "input": {
                    "imageSettings": settings,
                    "document": {"assets": value["assets"]},
                }
            },
        )


@pytest.mark.asyncio
async def test_ten_independent_objects_generate_without_paid_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value = fixture()
    generated: list[str] = []
    uploaded: list[str] = []

    class Api:
        async def call(self, *args: Any) -> None:
            pass

    class Provider:
        async def generate_image(self, prompt: str, settings: Any) -> bytes:
            generated.append(prompt)
            return b"controlled"

    async def upload(api: Any, id: str, image: bytes) -> None:
        uploaded.append(id)

    monkeypatch.setattr(module, "upload_image", upload)
    await module.run_image(
        Api(),
        Provider(),
        {
            "input": {
                "imageSettings": {
                    "model": "doubao-seedream-5-0-pro-260628",
                    "resolution": "2K",
                    "ratio": "1:1",
                    "assetIds": value["eligibleIds"],
                },
                "document": {"assets": value["assets"]},
            }
        },
    )
    assert len(generated) == 10 and set(uploaded) == set(value["eligibleIds"])
    scene_prompt = next(p for p in generated if "对象名称：清晨家门口" in p)
    assert "木边柜" in scene_prompt and "受控附属定义" in scene_prompt
    assert "通勤人群" not in scene_prompt and "独立物件0" not in scene_prompt
