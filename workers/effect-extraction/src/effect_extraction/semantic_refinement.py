from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import combinations
from typing import Any

from .models import ExtractionCandidate, SemanticField, SemanticGroup
from .providers import AiProvider

SEMANTIC_FIELDS: tuple[tuple[SemanticField, str], ...] = (
    (SemanticField.CORE_PAIN_POINTS, "core_pain_points"),
    (SemanticField.DECISION_DRIVERS, "decision_drivers"),
    (SemanticField.USAGE_SCENARIOS, "usage_scenarios"),
    (SemanticField.PURCHASE_SCENARIOS, "purchase_scenarios"),
    (SemanticField.EMOTIONAL_SCENARIOS, "emotional_scenarios"),
)


@dataclass(frozen=True, slots=True)
class SemanticRefinementResult:
    candidate: ExtractionCandidate
    metadata: dict[str, Any]


async def refine_candidate_semantics(
    candidate: ExtractionCandidate,
    *,
    provider: AiProvider,
) -> SemanticRefinementResult:
    """Recall likely duplicates with vectors, then let one strict AI call decide merges."""

    refined = candidate.model_copy(deep=True)
    facts, facts_by_id = _facts(candidate)
    input_count = sum(
        len(getattr(candidate, attr) or []) for _, attr in SEMANTIC_FIELDS
    )
    for field, attr in SEMANTIC_FIELDS:
        cleaned_values = [row["value"] for row in facts if row["field"] == field.value]
        setattr(refined, attr, cleaned_values or None)
    exact_output_count = len(facts)
    fields_with_pairs = {
        row["field"]
        for row in facts
        if sum(other["field"] == row["field"] for other in facts) > 1
    }
    if not fields_with_pairs:
        return SemanticRefinementResult(
            candidate=refined,
            metadata=_metadata(
                input_count=input_count, output_count=exact_output_count
            ),
        )

    embedding_texts = list(dict.fromkeys(row["value"] for row in facts))
    embeddings = await provider.embed_semantic_texts(embedding_texts)
    if len(embeddings.vectors) != len(embedding_texts):
        raise ValueError("semantic embedding response count mismatch")
    vector_by_text = dict(zip(embedding_texts, embeddings.vectors, strict=True))
    pairs = _candidate_pairs(facts, [vector_by_text[row["value"]] for row in facts])
    if not pairs:
        return SemanticRefinementResult(
            candidate=refined,
            metadata=_metadata(
                input_count=input_count,
                output_count=exact_output_count,
                embedding=embeddings,
            ),
        )

    ai_call = await provider.refine_semantics(facts=facts, candidate_pairs=pairs)
    groups = _validated_groups(
        ai_call.value.groups,
        facts_by_id=facts_by_id,
        candidate_pairs=pairs,
    )
    public_groups: list[dict[str, Any]] = []
    for field, attr in SEMANTIC_FIELDS:
        values = getattr(refined, attr) or []
        field_groups = [group for group in groups if group.field == field]
        setattr(refined, attr, _apply_groups(values, field_groups, facts_by_id) or None)
        for group in field_groups:
            public_groups.append(
                {
                    "field": field.value,
                    "canonicalValue": group.canonical_value.strip(),
                    "memberValues": [
                        facts_by_id[fact_id]["value"]
                        for fact_id in group.member_fact_ids
                    ],
                    "relation": group.relation.value,
                }
            )
    output_count = sum(len(getattr(refined, attr) or []) for _, attr in SEMANTIC_FIELDS)
    return SemanticRefinementResult(
        candidate=refined,
        metadata=_metadata(
            input_count=input_count,
            output_count=output_count,
            candidate_pair_count=len(pairs),
            groups=public_groups,
            embedding=embeddings,
            ai_call=ai_call.metadata.as_dict(),
        ),
    )


def _facts(
    candidate: ExtractionCandidate,
) -> tuple[list[dict[str, str]], dict[str, dict[str, str]]]:
    facts: list[dict[str, str]] = []
    for field, attr in SEMANTIC_FIELDS:
        seen: set[str] = set()
        for value in getattr(candidate, attr) or []:
            cleaned = re.sub(r"\s+", " ", value).strip()
            signature = re.sub(r"[\s，。；、,.!?！？：:（）()\-]+", "", cleaned).lower()
            if not cleaned or signature in seen:
                continue
            seen.add(signature)
            facts.append(
                {
                    "factId": f"{field.value}-{len([row for row in facts if row['field'] == field.value]) + 1:02d}",
                    "field": field.value,
                    "value": cleaned,
                }
            )
    return facts, {row["factId"]: row for row in facts}


def _candidate_pairs(
    facts: list[dict[str, str]],
    vectors: list[tuple[float, ...]],
) -> list[dict[str, str | float]]:
    scores: dict[tuple[int, int], float] = {}
    selected: set[tuple[int, int]] = set()
    for left, right in combinations(range(len(facts)), 2):
        if facts[left]["field"] != facts[right]["field"]:
            continue
        score = max(0.0, min(1.0, _cosine(vectors[left], vectors[right])))
        scores[(left, right)] = score
        if score >= 0.62:
            selected.add((left, right))

    # Vector similarity is recall, not the merge decision. Keep each fact's nearest
    # neighbour above a low floor so paraphrases with little literal overlap still reach Seed.
    for index in range(len(facts)):
        neighbours = sorted(
            [(pair, score) for pair, score in scores.items() if index in pair],
            key=lambda row: row[1],
            reverse=True,
        )
        for pair, _score in neighbours[:2]:
            selected.add(pair)
    return [
        {
            "leftFactId": facts[left]["factId"],
            "rightFactId": facts[right]["factId"],
            "similarity": round(scores[(left, right)], 4),
        }
        for left, right in sorted(selected)
    ]


def _validated_groups(
    groups: list[SemanticGroup],
    *,
    facts_by_id: dict[str, dict[str, str]],
    candidate_pairs: Sequence[Mapping[str, Any]],
) -> list[SemanticGroup]:
    adjacency: dict[str, set[str]] = {fact_id: set() for fact_id in facts_by_id}
    for pair in candidate_pairs:
        left, right = str(pair["leftFactId"]), str(pair["rightFactId"])
        adjacency[left].add(right)
        adjacency[right].add(left)
    used: set[str] = set()
    accepted: list[SemanticGroup] = []
    for group in groups:
        member_ids = list(dict.fromkeys(group.member_fact_ids))
        if len(member_ids) < 2 or any(
            member_id not in facts_by_id for member_id in member_ids
        ):
            continue
        if used.intersection(member_ids):
            continue
        rows = [facts_by_id[member_id] for member_id in member_ids]
        if any(row["field"] != group.field.value for row in rows):
            continue
        if not _connected(member_ids, adjacency):
            continue
        canonical = re.sub(r"\s+", " ", group.canonical_value).strip()
        if not canonical:
            continue
        accepted.append(
            group.model_copy(
                update={"member_fact_ids": member_ids, "canonical_value": canonical}
            )
        )
        used.update(member_ids)
    return accepted


def _connected(member_ids: list[str], adjacency: dict[str, set[str]]) -> bool:
    expected = set(member_ids)
    visited: set[str] = set()
    pending = [member_ids[0]]
    while pending:
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        pending.extend(adjacency[current].intersection(expected).difference(visited))
    return visited == expected


def _apply_groups(
    values: list[str],
    groups: list[SemanticGroup],
    facts_by_id: dict[str, dict[str, str]],
) -> list[str]:
    replacements: dict[str, tuple[str, set[str]]] = {}
    for group in groups:
        members = {facts_by_id[fact_id]["value"] for fact_id in group.member_fact_ids}
        first = next((value for value in values if value in members), None)
        if first is not None:
            replacements[first] = (group.canonical_value, members)
    consumed: set[str] = set()
    output: list[str] = []
    for value in values:
        if value in consumed:
            continue
        replacement = replacements.get(value)
        if replacement is None:
            output.append(value)
            continue
        canonical, members = replacement
        output.append(canonical)
        consumed.update(members)
    return output


def _metadata(
    *,
    input_count: int,
    output_count: int,
    candidate_pair_count: int = 0,
    groups: list[dict[str, Any]] | None = None,
    embedding: Any | None = None,
    ai_call: dict[str, Any] | None = None,
) -> dict[str, Any]:
    rows = groups or []
    metadata: dict[str, Any] = {
        "inputCount": input_count,
        "outputCount": output_count,
        "mergedGroupCount": len(rows),
        "candidatePairCount": candidate_pair_count,
        "semanticGroups": rows,
    }
    if embedding is not None:
        metadata["embedding"] = {
            "model": embedding.model,
            "requestCount": embedding.request_count,
            "retryCount": embedding.retry_count,
            "inputTokens": embedding.input_tokens,
            "latencyMs": embedding.latency_ms,
        }
    if ai_call is not None:
        metadata["aiCall"] = ai_call
    return metadata


def _cosine(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    if len(left) != len(right) or not left:
        raise ValueError("semantic embedding vectors must share a non-zero dimension")
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        raise ValueError("semantic embedding vectors cannot have zero norm")
    return sum(a * b for a, b in zip(left, right, strict=True)) / (
        left_norm * right_norm
    )
