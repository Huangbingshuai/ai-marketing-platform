from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from .models import BranchName, BranchOutput, BranchStatus, ExtractionCandidate

SCALAR_FIELDS = (
    "product_category",
    "product_name",
    "core_specification",
    "price_range",
    "visual_features",
    "target_audience",
    "marketing_goal",
    "usage_scenarios",
    "delivery_channels",
    "brand_tone",
)
LIST_FIELDS = ("core_selling_points", "disabled_elements")
PRIORITY = (
    BranchName.FORM,
    BranchName.DOCUMENT,
    BranchName.COMMERCE,
    BranchName.IMAGE,
)


class FusionError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class FusionResult:
    candidate: ExtractionCandidate
    provenance: dict[str, str]
    warnings: list[str]


def _key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return re.sub(r"\s+", " ", normalized).strip().casefold()


def _branch_candidate(output: BranchOutput) -> ExtractionCandidate | None:
    if output.candidate is not None:
        return output.candidate
    candidates = [item.candidate for item in output.items if item.candidate is not None]
    if not candidates:
        return None
    merged = ExtractionCandidate.empty()
    for field in SCALAR_FIELDS:
        for candidate in candidates:
            value = getattr(candidate, field)
            if isinstance(value, str) and value.strip():
                setattr(merged, field, value.strip())
                break
    for field in LIST_FIELDS:
        list_values: list[str] = []
        seen: set[str] = set()
        for candidate in candidates:
            for value in getattr(candidate, field) or []:
                canonical = _key(value)
                if canonical and canonical not in seen:
                    seen.add(canonical)
                    list_values.append(value.strip())
        setattr(merged, field, list_values or None)
    return merged


def fuse(branches: list[BranchOutput]) -> FusionResult:
    by_name = {branch.branch: branch for branch in branches}
    form = by_name.get(BranchName.FORM)
    if form is None or form.status == BranchStatus.FAILED:
        raise FusionError("required FORM branch did not succeed")

    ordered: list[tuple[BranchName, ExtractionCandidate]] = []
    warnings: list[str] = []
    for name in PRIORITY:
        output = by_name.get(name)
        if output is None:
            warnings.append(f"{name.value} branch output is missing")
            continue
        warnings.extend(output.warnings)
        candidate = _branch_candidate(output)
        if candidate is not None:
            ordered.append((name, candidate))

    fused = ExtractionCandidate.empty()
    provenance: dict[str, str] = {}
    for field in SCALAR_FIELDS:
        values: list[tuple[BranchName, str]] = []
        for source, candidate in ordered:
            value = getattr(candidate, field)
            if isinstance(value, str) and value.strip():
                values.append((source, value.strip()))
        if not values:
            continue
        winner_source, winner = values[0]
        setattr(fused, field, winner)
        provenance[field] = winner_source.value
        conflicting = [(source, value) for source, value in values[1:] if _key(value) != _key(winner)]
        if conflicting:
            warnings.append(
                f"{field} conflict resolved in favor of {winner_source.value}; "
                + ", ".join(source.value for source, _ in conflicting)
                + " retained as alternatives"
            )

    for field in LIST_FIELDS:
        list_values: list[str] = []
        seen: set[str] = set()
        sources: list[str] = []
        for source, candidate in ordered:
            added = False
            for value in getattr(candidate, field) or []:
                canonical = _key(value)
                if canonical and canonical not in seen:
                    seen.add(canonical)
                    list_values.append(value.strip())
                    added = True
            if added:
                sources.append(source.value)
        setattr(fused, field, list_values or None)
        if sources:
            provenance[field] = ">".join(sources)

    return FusionResult(candidate=fused, provenance=provenance, warnings=_dedupe(warnings))


def _dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        canonical = _key(value)
        if canonical and canonical not in seen:
            seen.add(canonical)
            result.append(value)
    return result


def candidate_metadata(candidate: ExtractionCandidate) -> dict[str, Any]:
    return candidate.model_dump(mode="json", by_alias=True)
