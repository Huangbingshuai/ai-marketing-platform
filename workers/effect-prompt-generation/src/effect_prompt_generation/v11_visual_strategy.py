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

DEFAULT_VISUAL_INSTRUCTIONS = {
    FactVisualUsage.IDENTITY_ANCHOR: "让当前产品或品类成为明确画面主体",
    FactVisualUsage.DIRECTLY_VISIBLE: "只呈现该事实可直接观察的外观或包装",
    FactVisualUsage.ACTION_DEMONSTRABLE: "通过一个连续真实动作呈现该事实",
}

DEFAULT_CONTEXT_INSTRUCTIONS = {
    FactVisualUsage.CONTEXT_ONLY: "只影响场景、人物或商业方向",
    FactVisualUsage.TEXT_ONLY: "仅通过准确文字或口播表达",
    FactVisualUsage.FORBIDDEN_VISUAL_PROOF: "只作商业背景，不作为视觉证明",
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
        visual_instruction = policy.visual_instruction
        context_instruction = policy.context_instruction
        forbidden_inferences = policy.forbidden_inferences
        if usage in VISIBLE_USAGES and not visual_instruction:
            visual_instruction = DEFAULT_VISUAL_INSTRUCTIONS[usage]
        if usage in CONTEXT_USAGES and not context_instruction:
            context_instruction = DEFAULT_CONTEXT_INSTRUCTIONS[usage]
        if usage == FactVisualUsage.FORBIDDEN_VISUAL_PROOF and not forbidden_inferences:
            forbidden_inferences = ["不得用成品外观或人物反应证明该事实"]

        normalized.append(
            policy.model_copy(
                update={
                    "visual_usage": usage,
                    "visual_instruction": visual_instruction,
                    "context_instruction": context_instruction,
                    "compatible_fact_ids": compatible,
                    "forbidden_inferences": forbidden_inferences,
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
