from __future__ import annotations
from collections import Counter
import json
from typing import Any


class MechanicalValidationError(ValueError):
    """All mechanical issues from one candidate, with no quote/body logging."""

    def __init__(self, issues: list[str]) -> None:
        self.issues = issues
        super().__init__("\n".join(issues))


def validate_review_correction(
    original: dict[str, Any], corrected: dict[str, Any]
) -> None:
    # Structural correction can fix reference paths/quotes, not erase a business error.
    def findings(value: dict[str, Any]) -> Counter[str]:
        return Counter(
            json.dumps(
                {
                    key: finding.get(key)
                    for key in (
                        "severity",
                        "category",
                        "repairKind",
                        "title",
                        "impact",
                        "suggestedFix",
                    )
                },
                sort_keys=True,
                ensure_ascii=False,
            )
            for finding in value.get("findings", [])
        )

    ids = [finding["id"] for finding in original.get("findings", [])]
    fixed_ids = [finding["id"] for finding in corrected.get("findings", [])]
    if findings(original) != findings(corrected) or (
        len(ids) == len(set(ids)) and set(ids) != set(fixed_ids)
    ):
        raise MechanicalValidationError(
            [
                "review structural correction must preserve original business findings and severity"
            ]
        )
