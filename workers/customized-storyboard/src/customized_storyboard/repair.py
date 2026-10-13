"""Typed sparse edits; AI decides changes, code applies and audits them mechanically."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import Field

from .models import (
    Asset,
    AssetGroup,
    Change,
    Dialogue,
    Id,
    Model,
    Repair,
    Script,
    Seconds,
    Shot,
    Text,
)


class ScriptField(Model):
    field: Literal["name", "synopsis", "structure", "productFocus"]
    value: Text
    reason: Text


class ShotField(Model):
    shotId: Id
    field: Literal[
        "title", "shotType", "cameraMovement", "visual", "audio", "continuity"
    ]
    value: Text
    reason: Text


class ShotTiming(Model):
    shotId: Id
    durationSeconds: Seconds
    reason: Text


class ShotDialogues(Model):
    shotId: Id
    dialogues: Annotated[list[Dialogue], Field(max_length=100)]
    reason: Text


class ShotReferences(Model):
    shotId: Id
    kind: Literal["characters", "products", "scenes"]
    group: AssetGroup
    reason: Text


class AssetField(Model):
    assetId: Id
    field: Literal["name", "description"]
    value: Text
    reason: Text


class InsertShot(Model):
    afterShotId: Id | None
    shot: Shot
    reason: Text


class RemoveShot(Model):
    shotId: Id
    reason: Text


class NewAsset(Model):
    asset: Asset
    reason: Text


class RepairPatch(Model):
    reason: Text
    scriptFields: Annotated[list[ScriptField], Field(max_length=4)]
    shotFields: Annotated[list[ShotField], Field(max_length=3000)]
    shotTimings: Annotated[list[ShotTiming], Field(max_length=500)]
    shotDialogues: Annotated[list[ShotDialogues], Field(max_length=500)]
    shotReferences: Annotated[list[ShotReferences], Field(max_length=1500)]
    assetFields: Annotated[list[AssetField], Field(max_length=2000)]
    insertShots: Annotated[list[InsertShot], Field(max_length=500)]
    removeShots: Annotated[list[RemoveShot], Field(max_length=500)]
    newAssets: Annotated[list[NewAsset], Field(max_length=1000)]


LABELS = {
    "name": "名称",
    "synopsis": "故事概述",
    "structure": "叙事结构",
    "productFocus": "产品关联",
    "title": "镜头标题",
    "shotType": "景别",
    "cameraMovement": "运镜",
    "visual": "画面内容",
    "audio": "声音",
    "continuity": "连续性",
    "durationSeconds": "时长",
    "dialogues": "对白",
    "description": "公共外观",
    "characters": "人物",
    "products": "产品",
    "scenes": "场景",
}


REPAIR_INSTRUCTION = (
    "只针对审校问题返回稀疏变更，不重写完整脚本，不输出未修改字段或原文对照。"
    "所有编辑使用原稿稳定id，正常镜头和对象原样保留；文本填写修改后的完整字段值。"
    "每项提供具体原因；未使用的数组返回[]。对象id和类别不得修改。"
    "必要时可增删镜头：afterShotId只能引用保留的原镜头，null表示片头；新增镜头id不得复用。"
    "时长变化需同步相关镜头并保持整片目标时长，结构时间标记须与最终镜头累计时长一致。"
    "同时修正画面、连续性、对白与本镜资产状态中确实受影响的内容，不只改一处掩盖问题。"
    "shotTimeline 是按当前镜头顺序和时长计算的真实时间轴。修改概述、结构时，以实际镜头事件及时间轴为依据，逐事件核对顺序。"
    "尤其检查概述每句话中的先后关系是否与镜头一致，不以旧概述的先后安排推测实际画面；修正一处时也要核对同一句前后的事件。"
)


def apply_repair(script: Script, patch: RepairPatch, target: int) -> Repair:
    data = script.model_dump()
    shots: dict[str, dict[str, Any]] = {s["id"]: s for s in data["shots"]}
    assets: dict[str, dict[str, Any]] = {a["id"]: a for a in data["assets"]}
    removed = [r.shotId for r in patch.removeShots]
    if len(set(removed)) != len(removed) or any(s not in shots for s in removed):
        raise ValueError("invalid removed shot identity")
    paths: set[tuple[str, ...]] = set()
    changes: list[Change] = []
    shot_numbers = {s.id: i + 1 for i, s in enumerate(script.shots)}
    asset_names = {
        a.id: a.name for a in [*script.assets, *(n.asset for n in patch.newAssets)]
    }

    def readable(value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, (int, float)):
            return f"{value:g} 秒"
        if isinstance(value, list):
            return "\n".join(readable(item) for item in value) or "无"
        if isinstance(value, dict):
            if "speaker" in value and "text" in value:
                return f"{value['speaker']}：{value['text']}"
            if "assetId" in value:
                return f"{asset_names.get(value['assetId'], '未定义对象')}：{value['description']}"
            if "state" in value:
                return readable(value["items"]) if value["items"] else "本镜不需要"
            return "\n".join(
                f"{LABELS.get(k, '资产需求')}：{readable(v)}"
                for k, v in value.items()
                if k not in {"id", "kind"}
            )
        raise ValueError("unsupported audit value")

    def location(parts: tuple[str, ...]) -> str:
        field = LABELS[parts[-1]]
        if parts[0] == "镜头":
            return f"第 {shot_numbers[parts[1]]:02d} 镜 · {field}"
        if parts[0] == "对象":
            return f"{asset_names[parts[1]]} · {field}"
        return f"脚本 · {field}"

    def audit(before: str, after: str, reason: str) -> None:
        # Keep every character even for large dialogue/reference arrays; the
        # public per-row text limit must not truncate the actual change record.
        for offset in range(0, max(len(before), len(after), 1), 20000):
            changes.append(
                Change(
                    before=before[offset : offset + 20000],
                    after=after[offset : offset + 20000],
                    reason=reason,
                )
            )

    def edit(
        container: dict[str, Any],
        field: str,
        value: Any,
        path: tuple[str, ...],
        reason: str,
    ) -> None:
        if path in paths:
            raise ValueError("duplicate repair field")
        paths.add(path)
        previous = container[field]
        if previous != value:
            audit(readable(previous), readable(value), f"{location(path)}：{reason}")
            container[field] = value

    def shot(shot_id: str) -> dict[str, Any]:
        if shot_id not in shots or shot_id in removed:
            raise ValueError("repair references unknown or removed shot")
        return shots[shot_id]

    for root in patch.scriptFields:
        edit(data, root.field, root.value, ("脚本", root.field), root.reason)
    for item in patch.shotFields:
        edit(
            shot(item.shotId),
            item.field,
            item.value,
            ("镜头", item.shotId, item.field),
            item.reason,
        )
    for timing in patch.shotTimings:
        edit(
            shot(timing.shotId),
            "durationSeconds",
            timing.durationSeconds,
            ("镜头", timing.shotId, "durationSeconds"),
            timing.reason,
        )
    for dialogue in patch.shotDialogues:
        edit(
            shot(dialogue.shotId),
            "dialogues",
            [d.model_dump() for d in dialogue.dialogues],
            ("镜头", dialogue.shotId, "dialogues"),
            dialogue.reason,
        )
    for ref in patch.shotReferences:
        edit(
            shot(ref.shotId)["assetRequirements"],
            ref.kind,
            ref.group.model_dump(),
            ("镜头", ref.shotId, "assetRequirements", ref.kind),
            ref.reason,
        )
    for asset in patch.assetFields:
        if asset.assetId not in assets:
            raise ValueError("repair references unknown asset")
        edit(
            assets[asset.assetId],
            asset.field,
            asset.value,
            ("对象", asset.assetId, asset.field),
            asset.reason,
        )
    for added in patch.newAssets:
        if added.asset.id in assets:
            raise ValueError("duplicate new asset identity")
        assets[added.asset.id] = added.asset.model_dump()
        data["assets"].append(assets[added.asset.id])
        audit(
            "",
            readable(added.asset.model_dump()),
            f"新增对象「{added.asset.name}」：{added.reason}",
        )
    additions: dict[str | None, list[dict[str, Any]]] = {}
    used_ids = set(shots)
    for inserted in patch.insertShots:
        if inserted.shot.id in used_ids:
            raise ValueError("duplicate inserted shot identity")
        used_ids.add(inserted.shot.id)
        if inserted.afterShotId is not None:
            shot(inserted.afterShotId)
        additions.setdefault(inserted.afterShotId, []).append(
            inserted.shot.model_dump()
        )
        audit(
            "",
            readable(inserted.shot.model_dump()),
            f"新增镜头「{inserted.shot.title}」：{inserted.reason}",
        )
    result = additions.get(None, []).copy()
    for original in data["shots"]:
        if original["id"] not in removed:
            result.append(original)
            result.extend(additions.get(original["id"], []))
    for deleted in patch.removeShots:
        audit(
            readable(shots[deleted.shotId]),
            "",
            f"移除第 {shot_numbers[deleted.shotId]:02d} 镜：{deleted.reason}",
        )
    data["shots"] = result
    repaired = Script.model_validate(data)
    repaired.check_duration(target)
    return Repair(script=repaired, reason=patch.reason, changes=changes)
