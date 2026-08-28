from __future__ import annotations

import hashlib
import json

from .models import (
    FactVisualPolicyDraft,
    FactVisualStrategy,
    FactVisualStrategyResponse,
    FactVisualUsage,
    InsightApplicationMap,
    InsightField,
)


VISIBLE_USAGES = {
    FactVisualUsage.IDENTITY_ANCHOR,
    FactVisualUsage.DIRECTLY_VISIBLE,
    FactVisualUsage.ACTION_DEMONSTRABLE,
}

CONTEXT_USAGES = {
    FactVisualUsage.CONTEXT_ONLY,
    FactVisualUsage.TEXT_ONLY,
    FactVisualUsage.FORBIDDEN_VISUAL_PROOF,
}


def validate_fact_visual_strategy(
    response: FactVisualStrategyResponse,
    application: InsightApplicationMap,
    *,
    source_content_hash: str,
    prompt_version: str,
) -> FactVisualStrategy:
    usable_by_id = {fact.fact_id: fact for fact in application.usable}
    policy_ids = [policy.fact_id for policy in response.policies]
    if len(policy_ids) != len(set(policy_ids)):
        raise ValueError("fact visual strategy contains duplicate factId")
    if set(policy_ids) != set(usable_by_id):
        raise ValueError("fact visual strategy must cover every usable fact exactly once")

    normalized: list[FactVisualPolicyDraft] = []
    for policy in response.policies:
        fact = usable_by_id[policy.fact_id]
        compatible = list(dict.fromkeys(policy.compatible_fact_ids))
        if any(fact_id not in usable_by_id for fact_id in compatible):
            raise ValueError("fact visual strategy references an unknown compatible fact")
        compatible = [fact_id for fact_id in compatible if fact_id != policy.fact_id]

        usage = policy.visual_usage
        if fact.field in {InsightField.PRODUCT_NAME, InsightField.PRODUCT_CATEGORY}:
            usage = FactVisualUsage.IDENTITY_ANCHOR
        if usage in VISIBLE_USAGES and not policy.visual_instruction:
            raise ValueError("visible fact policy requires visualInstruction")
        if usage in CONTEXT_USAGES and not policy.context_instruction:
            raise ValueError("context fact policy requires contextInstruction")
        if (
            usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF
            and not policy.forbidden_inferences
        ):
            raise ValueError("forbidden visual proof policy requires forbiddenInferences")

        normalized.append(
            policy.model_copy(
                update={
                    "visual_usage": usage,
                    "compatible_fact_ids": compatible,
                }
            )
        )

    if not any(policy.visual_usage in VISIBLE_USAGES for policy in normalized):
        raise ValueError("fact visual strategy does not contain a usable visual task")

    payload = [
        policy.model_dump(mode="json", by_alias=True)
        for policy in sorted(normalized, key=lambda item: item.fact_id)
    ]
    strategy_hash = hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return FactVisualStrategy(
        source_content_hash=source_content_hash,
        prompt_version=prompt_version,
        strategy_hash=strategy_hash,
        policies=normalized,
    )


def strategy_stage_metadata(
    strategy: FactVisualStrategy,
    application: InsightApplicationMap,
    *,
    reused: bool,
) -> dict[str, object]:
    facts = application.by_id
    counts = {
        usage.value: sum(
            policy.visual_usage == usage for policy in strategy.policies
        )
        for usage in FactVisualUsage
    }
    samples = []
    for policy in strategy.policies[:3]:
        fact = facts[policy.fact_id]
        samples.append(
            {
                "field": fact.field.value,
                "value": fact.value,
                "visualUsage": policy.visual_usage.value,
                "visualInstruction": policy.visual_instruction,
                "contextInstruction": policy.context_instruction,
                "forbiddenInferences": policy.forbidden_inferences,
            }
        )
    return {
        "policyCount": len(strategy.policies),
        "usageCounts": counts,
        "reusedCheckpoint": reused,
        "sourceContentHashMatched": True,
        "samples": samples,
        "checkpoint": {
            "nodeId": "FACT_VISUAL_STRATEGY_COMPILATION",
            "sourceFingerprint": strategy.source_content_hash,
            "allocationHash": strategy.strategy_hash,
            "promptVersion": strategy.prompt_version,
            "plan": strategy.model_dump(mode="json", by_alias=True),
        },
    }
