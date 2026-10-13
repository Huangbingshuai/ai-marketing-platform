from copy import deepcopy
import pytest
from customized_storyboard.models import Script
from customized_storyboard.repair import RepairPatch, apply_repair
from test_pipeline import shot


def script():
    return Script.model_validate(
        {
            "id": "script",
            "name": "标题",
            "synopsis": "故事",
            "structure": "叙事",
            "productFocus": "事实",
            "assets": [
                {
                    "id": "product",
                    "kind": "products",
                    "name": "商品",
                    "description": "已知外观",
                }
            ],
            "shots": [shot("s1", 10), shot("s2", 10), shot("s3", 10)],
        }
    )


def patch(**edits):
    return RepairPatch.model_validate(
        {
            "reason": "解决具体问题",
            "scriptFields": [],
            "shotFields": [],
            "shotTimings": [],
            "shotDialogues": [],
            "shotReferences": [],
            "assetFields": [],
            "insertShots": [],
            "removeShots": [],
            "newAssets": [],
            **edits,
        }
    )


def test_sparse_repair_preserves_every_untouched_field_and_audits_actual_values():
    original = script()
    before = original.model_dump()
    result = apply_repair(
        original,
        patch(
            shotFields=[
                {
                    "shotId": "s2",
                    "field": "visual",
                    "value": "携带电脑后再入场",
                    "reason": "前后携带一致",
                },
                {
                    "shotId": "s2",
                    "field": "continuity",
                    "value": "承接前镜电脑位置",
                    "reason": "位置连续",
                },
            ]
        ),
        30,
    )
    expected = deepcopy(before)
    expected["shots"][1].update(
        visual="携带电脑后再入场", continuity="承接前镜电脑位置"
    )
    assert result.script.model_dump() == expected
    assert original.model_dump() == before
    assert len(result.changes) == 2
    assert result.changes[0].before == before["shots"][1]["visual"]
    assert "第 02 镜 · 画面内容" in result.changes[0].reason


@pytest.mark.parametrize(
    "edits",
    [
        {
            "shotFields": [
                {
                    "shotId": "unknown",
                    "field": "visual",
                    "value": "内容",
                    "reason": "修改",
                }
            ]
        },
        {
            "shotFields": [
                {"shotId": "s1", "field": "visual", "value": "内容", "reason": "修改"}
            ]
            * 2
        },
        {"removeShots": [{"shotId": "s1", "reason": "移除"}] * 2},
        {
            "removeShots": [{"shotId": "s1", "reason": "移除"}],
            "shotTimings": [{"shotId": "s1", "durationSeconds": 20, "reason": "修改"}],
        },
        {"shotTimings": [{"shotId": "s1", "durationSeconds": 20, "reason": "修改"}]},
        {
            "assetFields": [
                {
                    "assetId": "unknown",
                    "field": "description",
                    "value": "内容",
                    "reason": "修改",
                }
            ]
        },
        {
            "insertShots": [
                {"afterShotId": "s1", "shot": shot("s1", 10), "reason": "新增"}
            ]
        },
        {
            "insertShots": [
                {"afterShotId": "unknown", "shot": shot("s4", 10), "reason": "新增"}
            ]
        },
        {
            "shotReferences": [
                {
                    "shotId": "s1",
                    "kind": "products",
                    "group": {
                        "state": "DEFINED",
                        "items": [{"assetId": "unknown", "description": "外观"}],
                    },
                    "reason": "修改",
                }
            ]
        },
        {
            "newAssets": [
                {
                    "asset": {
                        "id": "product",
                        "kind": "products",
                        "name": "重复",
                        "description": "描述",
                    },
                    "reason": "新增",
                }
            ]
        },
    ],
)
def test_invalid_sparse_changes_never_modify_input(edits):
    original = script()
    before = original.model_dump()
    with pytest.raises(ValueError):
        apply_repair(original, patch(**edits), 30)
    assert original.model_dump() == before


def test_insert_remove_reference_and_timing_edits_keep_final_order_and_identity():
    result = apply_repair(
        script(),
        patch(
            removeShots=[{"shotId": "s2", "reason": "不可执行"}],
            insertShots=[
                {"afterShotId": "s1", "shot": shot("new", 5), "reason": "拆分动作"}
            ],
            shotTimings=[
                {"shotId": "s3", "durationSeconds": 15, "reason": "为阅读留时间"}
            ],
            shotDialogues=[
                {
                    "shotId": "s3",
                    "dialogues": [{"id": "d1", "speaker": "人物", "text": "结束"}],
                    "reason": "对白安排",
                }
            ],
            scriptFields=[
                {"field": "structure", "value": "时间已对齐", "reason": "同步结构"}
            ],
        ),
        30,
    )
    assert result.script.id == "script"
    assert [s.id for s in result.script.shots] == ["s1", "new", "s3"]
    assert sum(s.durationSeconds for s in result.script.shots) == 30
    assert len(result.changes) == 5


def test_unsupported_fields_cannot_change_identity_or_kind():
    with pytest.raises(ValueError):
        patch(
            shotFields=[
                {"shotId": "s1", "field": "id", "value": "other", "reason": "修改"}
            ]
        )
    with pytest.raises(ValueError):
        patch(
            assetFields=[
                {
                    "assetId": "product",
                    "field": "kind",
                    "value": "scenes",
                    "reason": "修改",
                }
            ]
        )


def test_stable_ids_with_slashes_are_literal_and_never_exposed_in_audit():
    original = script()
    original.shots[0].id = "custom/shot/1"
    result = apply_repair(
        original,
        patch(
            shotFields=[
                {
                    "shotId": "custom/shot/1",
                    "field": "visual",
                    "value": "新画面",
                    "reason": "衔接",
                }
            ]
        ),
        30,
    )
    assert result.script.shots[0].id == "custom/shot/1"
    assert result.changes[0].reason == "第 01 镜 · 画面内容：衔接"


def test_long_actual_changes_are_preserved_without_truncation():
    long_shot = shot("new", 10)
    long_shot.update(visual="画" * 20000, continuity="连" * 20000)
    result = apply_repair(
        script(),
        patch(
            removeShots=[{"shotId": "s2", "reason": "替换"}],
            insertShots=[
                {"afterShotId": "s1", "shot": long_shot, "reason": "补足镜头"}
            ],
        ),
        30,
    )
    added = [c for c in result.changes if c.reason.startswith("新增镜头")]
    assert len(added) >= 3
    content = "".join(c.after for c in added)
    assert "画" * 20000 in content and "连" * 20000 in content
