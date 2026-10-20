from __future__ import annotations
import copy
import hashlib
import json
import base64
from uuid import UUID
from typing import Any
from .video_models import (
    VideoPlan,
    DirectorPlan,
    Audit,
    ScopedAudit,
    PromptAudit,
    PromptScopedAudit,
    Repair,
    TimingRepair,
    ClipPrompt,
)
from .mechanical_validation import MechanicalValidationError


def identity_prefix(seed: str) -> str:
    try:
        value = UUID(seed).bytes
    except ValueError:
        value = seed.encode()
    # Preserve the full task UUID in a shorter alphabet; no truncated hash collisions.
    return "v" + base64.urlsafe_b64encode(value).decode().rstrip("=")


def align_clip_boundaries(
    plan: dict[str, Any], clip_ids: set[str] | None = None
) -> None:
    """Clip boundary summaries project the actual first/last shot, not a second state.

    Only call when assembling a new candidate or merging its affected repair scope.
    Never migrate a confirmed or historical document on read.
    """
    shots = {s["id"]: s for s in plan["shots"]}
    for clip in plan["clips"]:
        if clip_ids is None or clip["id"] in clip_ids:
            clip["startState"] = shots[clip["shotIds"][0]]["startState"]
            clip["endState"] = shots[clip["shotIds"][-1]]["endState"]


def fingerprint(value: Any) -> str:
    def clean(v: Any) -> Any:
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, list):
            return [clean(x) for x in v]
        if isinstance(v, dict):
            return {k: clean(v[k]) for k in sorted(v)}
        return v

    return hashlib.sha256(
        json.dumps(clean(value), ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def ms(seconds: float) -> int:
    return int(seconds * 1000 + 0.5)


def shot_duration_step(snapshot: dict[str, Any]) -> int | None:
    if snapshot.get("operation") != "SHOTS":
        return None
    step = snapshot.get("shotDurationStepMs")
    if "shotDurationStepMs" in snapshot and (type(step) is not int or step != 1000):
        raise ValueError("unsupported shot duration step")
    return step


def validate_duration_step(
    items: list[dict[str, Any]], snapshot: dict[str, Any]
) -> None:
    if shot_duration_step(snapshot) is not None and any(
        not float(item["durationSeconds"]).is_integer() for item in items
    ):
        raise ValueError(
            "complete storyboard duration must use whole seconds; cue windows retain milliseconds"
        )


def unique(items: list[dict[str, Any]]) -> bool:
    return len({v["id"] for v in items}) == len(items)


def excerpt(ref: dict[str, Any], units: list[dict[str, Any]]) -> str:
    unit = next((u for u in units if u["id"] == ref["unitId"]), None)
    if (
        not unit
        or ref["start"] < 0
        or ref["end"] <= ref["start"]
        or ref["end"] > len(unit["text"])
    ):
        raise ValueError(
            f"source reference outside immutable text: unitId={ref['unitId']}, requested=[{ref['start']},{ref['end']}), unit-relative allowed=[0,{len(unit['text']) if unit else 0}); full unit must use start=0/end=length, not full-script offsets"
        )
    return str(unit["text"][ref["start"] : ref["end"]])


def explicit_coverage(cues: list[dict[str, Any]], units: list[dict[str, Any]]) -> None:
    for unit in units:
        if unit["kind"] == "TEXT":
            continue
        refs = sorted(
            [c["sourceRef"] for c in cues if c["sourceRef"]["unitId"] == unit["id"]],
            key=lambda r: r["start"],
        )
        end = 0
        for ref in refs:
            if ref["start"] != end:
                raise ValueError("explicit speech or screen text is omitted/repeated")
            end = ref["end"]
        if end != len(unit["text"]):
            raise ValueError("explicit speech or screen text is not fully covered")


def validate_director(value: dict[str, Any], snapshot: dict[str, Any]) -> None:
    plan = DirectorPlan.model_validate(value).model_dump()
    if not plan["feasible"]:
        if plan["inputIssue"] == "NONE":
            raise ValueError("infeasible plan needs a concrete input issue")
        return
    if (
        plan["inputIssue"] != "NONE"
        or not plan["clips"]
        or not plan["scenes"]
        or not plan["events"]
    ):
        raise ValueError("feasible plan must contain events, scenes and clips")
    validate_duration_step(plan["clips"], snapshot)
    for key in ("events", "scenes", "clips", "cues"):
        if not unique(plan[key]):
            raise ValueError(f"duplicate {key}")
    scene_assets = {
        a["id"] for a in snapshot["document"]["assets"] if a["kind"] == "SCENE"
    }
    if any(s["sceneAssetId"] not in scene_assets for s in plan["scenes"]):
        raise ValueError("scene must reference confirmed scene asset")
    scene_ids = {s["id"] for s in plan["scenes"]}
    event_ids = {e["id"] for e in plan["events"]}
    clip_ids = {c["id"] for c in plan["clips"]}
    cap = snapshot["renderCapability"]
    for clip in plan["clips"]:
        if clip["sceneId"] not in scene_ids or any(
            e not in event_ids for e in clip["eventIds"]
        ):
            raise ValueError("invalid clip scene/event")
        if not cap["minClipMs"] <= ms(clip["durationSeconds"]) <= cap["maxClipMs"]:
            raise ValueError("planned clip exceeds capability")
    if any(
        not any(e["id"] in c["eventIds"] for c in plan["clips"]) for e in plan["events"]
    ):
        raise ValueError("director omitted an event")
    units = snapshot["sourceUnits"]
    range_errors = []
    for item in plan["events"] + plan["cues"]:
        for ref in item.get("sourceRefs", [item.get("sourceRef")]):
            try:
                excerpt(ref, units)
            except ValueError as error:
                range_errors.append(str(error))
    if range_errors:
        raise ValueError(
            "All invalid unit-relative source ranges: " + "; ".join(range_errors)
        )
    for event in plan["events"]:
        for ref in event["sourceRefs"]:
            excerpt(ref, units)
    for cue in plan["cues"]:
        length = len(excerpt(cue["sourceRef"], units))
        end = 0
        for allocation in cue["allocations"]:
            if (
                allocation["clipId"] not in clip_ids
                or not 0 <= allocation["textStart"] < allocation["textEnd"] <= length
            ):
                raise ValueError("invalid planned cue allocation")
            if cue["kind"] != "ON_SCREEN_TEXT":
                if allocation["textStart"] != end:
                    raise ValueError("planned speech is omitted/repeated")
                end = allocation["textEnd"]
            elif allocation["textStart"] != 0 or allocation["textEnd"] != length:
                raise ValueError("on-screen text must remain complete")
        if cue["kind"] != "ON_SCREEN_TEXT" and end != length:
            raise ValueError("planned speech is truncated")
    explicit_coverage(plan["cues"], units)
    policy = snapshot["durationPolicy"]
    if (
        policy["mode"] == "FIXED"
        and abs(
            sum(ms(c["durationSeconds"]) for c in plan["clips"]) - ms(policy["seconds"])
        )
        > 1000
    ):
        raise ValueError("fixed duration conflict must be reported as infeasible")


def validate_plan(value: dict[str, Any], snapshot: dict[str, Any]) -> None:
    plan = VideoPlan.model_validate(value).model_dump()
    validate_duration_step(plan["shots"], snapshot)
    for k, sk in [
        ("sourceUnits", "sourceUnits"),
        ("sources", "sources"),
        ("durationPolicy", "durationPolicy"),
        ("capability", "renderCapability"),
    ]:
        if fingerprint(plan[k]) != fingerprint(snapshot[sk]):
            raise ValueError("video plan changed frozen input")
    for key in ("sourceUnits", "events", "scenes", "clips", "shots", "cues"):
        if not unique(plan[key]):
            raise ValueError(f"duplicate {key}")
    assets = {a["id"]: a for a in snapshot["document"]["assets"]}
    scenes = {s["id"]: s for s in plan["scenes"]}
    shots = {s["id"]: s for s in plan["shots"]}
    events = {e["id"] for e in plan["events"]}
    for scene in plan["scenes"]:
        if assets.get(scene["sceneAssetId"], {}).get("kind") != "SCENE":
            raise ValueError("unknown scene asset")
    for event in plan["events"]:
        for ref in event["sourceRefs"]:
            excerpt(ref, plan["sourceUnits"])
    ordered = [s for c in plan["clips"] for s in c["shotIds"]]
    if len(ordered) != len(shots) or set(ordered) != set(shots):
        raise ValueError("each shot must belong to exactly one clip")
    if (
        snapshot.get("strategyVersion") == "2026-10-19-capacity-clips.7"
        and snapshot.get("operation") == "SHOTS"
        and any(len(c["shotIds"]) != 1 for c in plan["clips"])
    ):
        raise ValueError(
            "each video task must have exactly one complete storyboard, without child shots"
        )
    cap = plan["capability"]
    for clip in plan["clips"]:
        if clip["sceneId"] not in scenes or len(set(clip["shotIds"])) != len(
            clip["shotIds"]
        ):
            raise ValueError("invalid clip membership")
        total = sum(ms(shots[s]["durationSeconds"]) for s in clip["shotIds"])
        if not cap["minClipMs"] <= total <= cap["maxClipMs"]:
            raise ValueError("clip timing exceeds capability")
    for shot in plan["shots"]:
        if not all(
            shot[k].strip() for k in ("visual", "information", "startState", "endState")
        ):
            raise ValueError(
                "shot needs actual information, visible action and start/end states"
            )
        if abs(shot["durationSeconds"] * 1000 - ms(shot["durationSeconds"])) > 1e-6:
            raise ValueError("duration must use millisecond precision")
        refs = [b["assetId"] for b in shot["bindings"]]
        if (
            len(refs) != len(set(refs))
            or len(shot["sourceEventIds"]) != len(set(shot["sourceEventIds"]))
            or any(r not in assets for r in refs)
            or not set(shot["sourceEventIds"]) <= events
        ):
            raise ValueError("unknown/duplicate shot binding or source event")
    if any(not any(e in s["sourceEventIds"] for s in plan["shots"]) for e in events):
        raise ValueError("source event not covered by shots")
    for cue in plan["cues"]:
        length = len(excerpt(cue["sourceRef"], plan["sourceUnits"]))
        end = 0
        last_order = -1
        last_end_ms = -1
        for part in cue["parts"]:
            shot = shots.get(part["shotId"])
            if (
                not shot
                or part["endMs"] <= part["startMs"]
                or part["endMs"] > ms(shot["durationSeconds"])
                or not 0 <= part["textStart"] < part["textEnd"] <= length
            ):
                raise ValueError("cue outside shot time/source range")
            current_order = ordered.index(part["shotId"])
            if current_order == last_order and part["startMs"] < last_end_ms:
                raise ValueError("cue parts overlap within the same shot")
            last_end_ms = part["endMs"]
            if current_order < last_order:
                raise ValueError("speech source order differs from video order")
            last_order = current_order
            if cue["kind"] != "ON_SCREEN_TEXT":
                if part["textStart"] != end:
                    raise ValueError("speech omitted/repeated across shots")
                end = part["textEnd"]
            elif part["textStart"] != 0 or part["textEnd"] != length:
                raise ValueError("screen text is truncated")
        if cue["kind"] != "ON_SCREEN_TEXT" and end != length:
            raise ValueError("speech not fully assigned")
    explicit_coverage(plan["cues"], plan["sourceUnits"])
    policy = plan["durationPolicy"]
    if (
        policy["mode"] == "FIXED"
        and abs(
            sum(ms(s["durationSeconds"]) for s in plan["shots"]) - ms(policy["seconds"])
        )
        > 1000
    ):
        raise ValueError("fixed total timing mismatch")


def evidence_value(
    plan: dict[str, Any], e: dict[str, Any], prompt: dict[str, Any] | None = None
) -> Any:
    if e["entity"] == "PROMPT":
        if (
            not prompt
            or e["id"] != prompt["target"]["id"]
            or e["field"] not in ("content", "assetIds")
        ):
            raise ValueError(
                f"prompt evidence must reference actual content: PROMPT:{e['id']}.{e['field']}; allowed fields: content, assetIds"
            )
        return prompt[e["field"]]
    if e["entity"] == "TIMING":
        item = plan["timing"]
    else:
        key = {
            "SHOT": "shots",
            "CLIP": "clips",
            "SCENE": "scenes",
            "CUE": "cues",
            "EVENT": "events",
            "SOURCE": "sourceUnits",
        }.get(e["entity"])
        item = next((v for v in plan.get(key or "", []) if v["id"] == e["id"]), None)
    if not item:
        raise ValueError(
            f"review evidence must select an actual field: unknown {e['entity']}:{e['id']}"
        )
    if e["field"] not in item:
        raise ValueError(
            f"review evidence must select an actual field: {e['entity']}:{e['id']}.{e['field']}; allowed fields: {', '.join(item)}"
        )
    if e["entity"] == "CUE" and e["field"] == "sourceRef":
        return excerpt(item["sourceRef"], plan["sourceUnits"])
    return item[e["field"]]


def validate_audit(
    value: dict[str, Any],
    plan: dict[str, Any],
    previous: dict[str, Any] | None = None,
    prompt: dict[str, Any] | None = None,
) -> None:
    schema = (
        (PromptScopedAudit if "severityChanges" in value else PromptAudit)
        if "promptEvidence" in value
        else (ScopedAudit if "severityChanges" in value else Audit)
    )
    audit = schema.model_validate(value).model_dump()
    issues: list[str] = []
    if len({c["dimension"] for c in audit["checks"]}) != 7:
        issues.append("review must check all seven actual dimensions")
    if not unique(audit["findings"]):
        issues.append("duplicate finding IDs")
    for finding in audit["findings"]:
        if not set(finding["affectedShotIds"]) <= {
            s["id"] for s in plan["shots"]
        } or not set(finding["affectedClipIds"]) <= {c["id"] for c in plan["clips"]}:
            issues.append(
                f"review refers to another candidate: finding={finding['id']}"
            )
        for index, evidence in enumerate(finding["evidence"]):
            try:
                evidence_value(plan, evidence, prompt)
            except ValueError as error:
                issues.append(f"{error}; findings[{finding['id']}].evidence[{index}]")
    if previous is None:
        if audit["resolutions"]:
            issues.append("initial review must not invent previous findings")
        if issues:
            raise MechanicalValidationError(issues)
        return
    errors = {f["id"] for f in previous["findings"] if f["severity"] == "ERROR"}
    if (
        len(audit["resolutions"]) != len(errors)
        or {r["issueId"] for r in audit["resolutions"]} != errors
    ):
        issues.append("recheck must resolve every original error exactly once")
    for resolution in audit["resolutions"]:
        for index, evidence in enumerate(resolution["evidence"]):
            try:
                evidence_value(plan, evidence, prompt)
            except ValueError as error:
                issues.append(
                    f"{error}; resolutions[{resolution['issueId']}].evidence[{index}]"
                )
    if issues:
        raise MechanicalValidationError(issues)


def apply_repair(
    original: dict[str, Any],
    raw: dict[str, Any],
    audit: dict[str, Any],
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    patch = (
        (
            TimingRepair
            if snapshot.get("strategyVersion")
            in {
                "2026-10-19-capacity-clips.5",
                "2026-10-19-capacity-clips.6",
                "2026-10-19-capacity-clips.7",
            }
            else Repair
        )
        .model_validate(raw)
        .model_dump()
    )
    if patch["baseHash"] != fingerprint(original):
        raise ValueError("repair based on another candidate")
    errors = {f["id"]: f for f in audit["findings"] if f["severity"] == "ERROR"}
    if set(patch["issueIds"]) != set(errors) or len(patch["issueIds"]) != len(errors):
        raise ValueError("repair must address precisely the original errors")
    value = copy.deepcopy(original)
    shot_ids = {sid for f in errors.values() for sid in f["affectedShotIds"]}
    affected_clips = {cid for f in errors.values() for cid in f["affectedClipIds"]}
    affected_clips.update(
        c["id"] for c in original["clips"] if set(c["shotIds"]) & shot_ids
    )
    for clip in original["clips"]:
        if clip["id"] in affected_clips:
            shot_ids.update(clip["shotIds"])
    seen: set[str] = set()
    for fields in patch["fields"]:
        sid = fields.pop("shotId")
        if sid not in shot_ids or sid in seen:
            raise ValueError("field repair changed unrelated shot")
        seen.add(sid)
        item = next(s for s in value["shots"] if s["id"] == sid)
        item.update({k: v for k, v in fields.items() if v is not None})
    removed_clips: set[str] = set()
    removed_shots: set[str] = set()
    replacements: list[
        tuple[
            int, int, list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]
        ]
    ] = []
    old_ids = [c["id"] for c in original["clips"]]
    new_scenes = {s["id"]: s for s in value["scenes"]}
    for index, replacement in enumerate(patch["ranges"]):
        ids = replacement["clipIds"]
        if (
            not set(ids) <= set(old_ids)
            or set(ids) & removed_clips
            or not set(ids) & affected_clips
        ):
            raise ValueError("structural repair scope is unrelated/overlapping")
        positions = [old_ids.index(cid) for cid in ids]
        if positions != list(range(min(positions), max(positions) + 1)):
            raise ValueError(
                "structural replacement must be an ordered contiguous range"
            )
        # Allow explicitly named boundary neighbours, not arbitrary full-film rewriting.
        if any(
            not any(
                abs(old_ids.index(cid) - old_ids.index(hit)) <= 1
                for hit in affected_clips
            )
            for cid in ids
        ):
            raise ValueError("structural repair expanded beyond affected boundaries")
        removed_clips.update(ids)
        removed_shots.update(
            s for c in original["clips"] if c["id"] in ids for s in c["shotIds"]
        )
        batch = copy.deepcopy(replacement["replacement"])
        prefix = f"{identity_prefix(snapshot['identitySeed'])}-r{index + 1}"
        mapping = {s["id"]: f"{prefix}-s{j + 1}" for j, s in enumerate(batch["shots"])}
        if len(mapping) != len(batch["shots"]):
            raise ValueError("duplicate replacement shot identity")
        for shot in batch["shots"]:
            shot["id"] = mapping[shot["id"]]
        for j, clip in enumerate(batch["clips"]):
            clip["id"] = f"{prefix}-c{j + 1}"
            clip["shotIds"] = [mapping[s] for s in clip["shotIds"]]
        for cue in batch["cueParts"]:
            original_cue = next(
                (c for c in original["cues"] if c["id"] == cue["cueId"]), None
            )
            if original_cue is None:
                raise ValueError("structural repair invented a cue identity")
            scoped_parts = []
            for part in cue["parts"]:
                if part["shotId"] not in mapping:
                    # Some structured responses echo unchanged neighbouring cues.
                    # Ignore only byte-for-byte existing parts outside this range;
                    # changed or invented out-of-scope parts remain a hard error.
                    if (
                        part["shotId"] not in removed_shots
                        and part in original_cue["parts"]
                    ):
                        continue
                    raise ValueError(
                        f"replacement cue {cue['cueId']} points outside replacement shots: {part['shotId']}"
                    )
                part["shotId"] = mapping[part["shotId"]]
                scoped_parts.append(part)
            cue["parts"] = scoped_parts
        for scene in replacement["scenes"]:
            if scene["id"] in new_scenes and scene != new_scenes[scene["id"]]:
                raise ValueError("repair may not redefine existing scene identity")
            new_scenes[scene["id"]] = scene
        replacements.append(
            (
                min(positions),
                max(positions) + 1,
                batch["clips"],
                batch["shots"],
                batch["cueParts"],
            )
        )
    if seen & removed_shots:
        raise ValueError("same shot cannot receive both field and range repairs")
    for start, stop, clips, _, _ in sorted(replacements, reverse=True):
        value["clips"][start:stop] = clips
    value["shots"] = [s for s in value["shots"] if s["id"] not in removed_shots] + [
        s for _, _, _, shots, _ in replacements for s in shots
    ]
    ordered = [sid for c in value["clips"] for sid in c["shotIds"]]
    value["shots"].sort(key=lambda s: ordered.index(s["id"]))
    for cue in value["cues"]:
        cue["parts"] = [p for p in cue["parts"] if p["shotId"] not in removed_shots] + [
            p
            for _, _, _, _, cps in replacements
            for cp in cps
            if cp["cueId"] == cue["id"]
            for p in cp["parts"]
        ]
        cue["parts"].sort(key=lambda p: (ordered.index(p["shotId"]), p["startMs"]))
        if not cue["parts"]:
            raise ValueError(
                f"structural repair omitted cue {cue['id']}: {excerpt(cue['sourceRef'], value['sourceUnits'])}; return its complete parts inside the replacement range"
            )
    if any(
        cp["cueId"] not in {c["id"] for c in value["cues"]}
        for _, _, _, _, cps in replacements
        for cp in cps
    ):
        raise ValueError("repair invented source speech")
    updated_cues: set[str] = set()
    for update in patch.get("cueUpdates", []):
        cue = next((c for c in value["cues"] if c["id"] == update["cueId"]), None)
        if cue is None or cue["id"] in updated_cues:
            raise ValueError("cue timing repair invented or repeated a cue")
        updated_cues.add(cue["id"])
        if any(
            p["shotId"] not in shot_ids or p["shotId"] in removed_shots
            for p in update["parts"]
        ):
            raise ValueError("cue timing repair changed an unrelated or replaced shot")
        cue["parts"] = [
            p for p in cue["parts"] if p["shotId"] not in shot_ids
        ] + copy.deepcopy(update["parts"])
        cue["parts"].sort(key=lambda p: (ordered.index(p["shotId"]), p["startMs"]))
    scene_ids = {c["sceneId"] for c in value["clips"]}
    value["scenes"] = [s for s in new_scenes.values() if s["id"] in scene_ids]
    value["timing"]["explanation"] = (
        patch["timingExplanation"] or value["timing"]["explanation"]
    )
    if snapshot.get("strategyVersion") in {
        "2026-10-19-capacity-clips.6",
        "2026-10-19-capacity-clips.7",
    }:
        align_clip_boundaries(
            value,
            affected_clips
            | {c["id"] for _, _, clips, _, _ in replacements for c in clips},
        )
    validate_plan(value, snapshot)
    return value


def validate_prompt(
    value: dict[str, Any],
    plan: dict[str, Any],
    clip_id: str,
    mentions_only: bool = False,
) -> None:
    prompt = ClipPrompt.model_validate(value).model_dump()
    clip = next(c for c in plan["clips"] if c["id"] == clip_id)
    expected = {
        b["assetId"]
        for s in plan["shots"]
        if s["id"] in clip["shotIds"]
        for b in s["bindings"]
    }
    actual = set(prompt["assetIds"])
    references_valid = actual <= expected if mentions_only else actual == expected
    if (
        prompt["target"] != {"kind": "CLIP", "id": clip_id}
        or not references_valid
        or len(prompt["assetIds"]) != len(actual)
    ):
        raise ValueError("prompt differs from actual clip references")
