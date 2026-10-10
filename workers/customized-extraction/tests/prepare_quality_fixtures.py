"""Prepare synthetic quality inputs locally; never contacts API/model services."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from prepare_paid_fixtures import prepare


def main() -> None:
    repo = Path(__file__).resolve().parents[3]
    directory = repo / "素材/定制类项目素材/原文审校验收"
    if (directory / "ledger.json").exists():
        raise ValueError(
            "Acceptance ledger already exists; keep pinned inputs unchanged"
        )
    prepare(directory)
    scenarios = json.loads((directory / "cases.json").read_text(encoding="utf-8"))
    selected = [
        c
        for c in scenarios
        if c["name"] in {"长文分片", "多文档补充冲突", "Excel多表换行"}
    ]
    shutil.copyfile(
        repo / "docs/workflows/customized/templates/视频创作简报填写示例.docx",
        directory / "标准简报.docx",
    )
    selected.insert(
        0,
        {
            "name": "标准简报原文审校",
            "files": [str(directory / "标准简报.docx")],
            "expectedStatus": "COMPLETED",
            "contains": [],
            "excludes": [],
            "noBlockingIssues": True,
        },
    )
    for scenario in selected:
        scenario.update(validateSources=True, requireUnconfirmed=True)
        if scenario["name"] == "长文分片":
            scenario["fieldContains"] = {"brandTone": ["真实自然", "克制", "轻盈"]}
    used = {Path(filename) for scenario in selected for filename in scenario["files"]}
    for filename in {
        Path(filename) for scenario in scenarios for filename in scenario["files"]
    } - used:
        if filename.resolve().parent != directory.resolve():
            raise ValueError("Fixture cleanup path is outside acceptance directory")
        filename.unlink()
    (directory / ".gitignore").write_text("ledger.json\ncases.json\n", encoding="utf-8")
    (directory / "cases.json").write_text(
        json.dumps(selected, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (directory / "说明.txt").write_text(
        "全部为虚构资料，仅用于信息提炼质量验收。覆盖标准简报、长文分片、多表 Excel、多文档真实规格冲突。cases.json 是预期断言；ledger.json 是本机付费任务台账，禁止删除后重复触发，也不应提交 Git。\n",
        encoding="utf-8",
    )
    print(f"Prepared {len(selected)} scenarios; no paid calls")


if __name__ == "__main__":
    main()
