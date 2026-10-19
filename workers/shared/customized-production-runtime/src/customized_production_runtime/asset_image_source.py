"""Exact ownership within a frozen Run catalog; never infer from names or images."""

from __future__ import annotations
from typing import Any


def image_source(assets: list[dict[str, Any]], object_id: str) -> dict[str, Any]:
    by_id = {a["id"]: a for a in assets}
    if len(by_id) != len(assets):
        raise ValueError("duplicate asset identity")
    current = by_id.get(object_id)
    seen: set[str] = set()
    while current is not None:
        if current["id"] in seen:
            raise ValueError("cyclic asset ownership")
        seen.add(current["id"])
        prep = current.get("preparation")
        if prep is None:
            return current
        treatment = prep.get("treatment")
        if treatment == "INDEPENDENT":
            if prep.get("parentId") is not None:
                raise ValueError("invalid independent parent")
            return current
        if treatment not in ("SCENE_DETAIL", "CHARACTER_DETAIL") or not prep.get(
            "parentId"
        ):
            raise ValueError("invalid detail ownership")
        parent = by_id.get(prep["parentId"])
        if parent is None:
            raise ValueError("parent is not in the current asset catalog")
        if current["kind"] == "PRODUCT" or parent["kind"] != (
            "SCENE" if treatment == "SCENE_DETAIL" else "CHARACTER"
        ):
            raise ValueError("invalid parent kind")
        current = parent
    raise ValueError("asset is not in the current asset catalog")


def text_image_ownership(assets: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for asset in assets:
        if not asset.get("preparation"):
            continue
        source = image_source(assets, asset["id"])
        if source["id"] != asset["id"]:
            result[asset["id"]] = {
                "sourceObjectId": source["id"],
                "sourceName": source["name"],
                "treatment": asset["preparation"]["treatment"],
            }
    return result
