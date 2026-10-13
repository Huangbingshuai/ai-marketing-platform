"""Explicit paid paired replay. Reads local evidence; never modifies an API task."""

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import time

from customized_storyboard.models import Review, Script, Repair
from customized_storyboard.provider import Provider
from customized_storyboard.repair import RepairPatch, apply_repair, REPAIR_INSTRUCTION


async def main():
    if os.getenv("CUSTOMIZED_STORYBOARD_PAID_TEST") != "1":
        raise RuntimeError("Explicit paid authorization required")
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    destination = Path(sys.argv[2])
    state = (
        json.loads(destination.read_text(encoding="utf-8"))
        if destination.exists()
        else {}
    )
    fingerprint = hashlib.sha256(
        json.dumps(fixture, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    if state and state.get("inputFingerprint") != fingerprint:
        raise RuntimeError("Replay input changed; use a new result file")
    state["inputFingerprint"] = fingerprint
    provider = Provider(
        os.getenv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        os.environ["ARK_API_KEY"],
    )
    context = {
        k: fixture["input"][k] for k in ("brief", "settings", "existingConcepts")
    }
    source = Script.model_validate(fixture["script"])
    original_review = Review.model_validate(fixture["review"])

    def persist():
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    try:
        if "repair" not in state:
            started = time.monotonic()
            patch = (
                RepairPatch.model_validate(state["patch"])
                if "patch" in state
                else await provider.generate(
                    "REPAIR",
                    fixture["input"]["models"][
                        "detail"
                        if all(
                            f.category == "STRUCTURE" for f in original_review.findings
                        )
                        else "creative"
                    ],
                    RepairPatch,
                    {
                        **context,
                        "script": source.model_dump(),
                        "shotTimeline": source.timeline(),
                        "review": original_review.model_dump(),
                    },
                    REPAIR_INSTRUCTION,
                )
            )
            state["patch"] = patch.model_dump()
            state.setdefault("patchSeconds", round(time.monotonic() - started, 3))
            persist()
            repair = apply_repair(
                source, patch, context["settings"]["targetDurationSeconds"]
            )
            state.update(
                repair=repair.model_dump(),
                repairSeconds=state["patchSeconds"],
            )
            persist()
        repair = Repair.model_validate(state["repair"])
        if "recheck" not in state:
            started = time.monotonic()
            recheck = await provider.generate(
                "RECHECK",
                fixture["input"]["models"]["creative"],
                Review,
                {
                    **context,
                    "script": repair.script.model_dump(),
                    "shotTimeline": repair.script.timeline(),
                    "originalReview": original_review.model_dump(),
                    "otherConcepts": {"concepts": []},
                },
                "独立复核当前 script 修订后的完整脚本，检查原问题是否解决及新增事实、结构、引用或连贯错误。originalReview 只是旧问题，不把旧描述当作当前稿。不要默认修订已通过。",
            )
            if any(
                sid not in {s.id for s in repair.script.shots}
                for f in recheck.findings
                for sid in f.shotIds
            ):
                raise RuntimeError("Recheck references unknown shots")
            state.update(
                recheck=recheck.model_dump(),
                recheckSeconds=round(time.monotonic() - started, 3),
            )
            persist()
        before = {s.id: s.model_dump() for s in source.shots}
        after = {s.id: s.model_dump() for s in repair.script.shots}
        summary = {
            "repairSeconds": state["repairSeconds"],
            "recheckSeconds": state["recheckSeconds"],
            "changes": len(repair.changes),
            "unchangedShots": sum(before[k] == after.get(k) for k in before),
            "shots": len(after),
            "duration": sum(s.durationSeconds for s in repair.script.shots),
            "findings": state["recheck"]["findings"],
        }
        state["summary"] = summary
        persist()
        print(
            json.dumps(
                {**summary, "findings": len(summary["findings"])}, ensure_ascii=False
            )
        )
        if any(f["severity"] == "ERROR" for f in summary["findings"]):
            raise RuntimeError("Independent recheck did not pass")
    finally:
        await provider.close()


logging.basicConfig(level=logging.INFO)
asyncio.run(main())
