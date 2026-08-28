from __future__ import annotations

import re
from functools import lru_cache
from importlib.resources import files


_VERSION = re.compile(r"^VERSION:\s*(\S+)\s*$", re.MULTILINE)
_VARIABLE = re.compile(r"\{([a-z][a-z0-9_]*)\}")

# V8-V10 runs are read-only, but the deterministic Mock compatibility tests still
# need their historical version identifiers and interpolation contracts. Keeping
# this compact registry avoids shipping 23 inactive model prompts while allowing
# old persisted run fixtures to be parsed without pretending they are V11.
_LEGACY_COMPATIBILITY_TEMPLATES = {
    "strategy_planning.prompt.txt": "VERSION: effect-prompt-strategy-v8\n目标数量：{target_count}\n事实：{insight_json}",
    "candidate_base.system.prompt.txt": "VERSION: effect-prompt-candidate-base-v9\n历史只读兼容模板。",
    "candidate_hook.system.prompt.txt": "VERSION: effect-prompt-candidate-hook-v5\n历史只读兼容模板。",
    "candidate_pain.system.prompt.txt": "VERSION: effect-prompt-candidate-pain-v3\n历史只读兼容模板。",
    "candidate_product_display.system.prompt.txt": "VERSION: effect-prompt-candidate-product-display-v4\n历史只读兼容模板。",
    "candidate_selling_point.system.prompt.txt": "VERSION: effect-prompt-candidate-selling-point-v4\n历史只读兼容模板。",
    "candidate_cta.system.prompt.txt": "VERSION: effect-prompt-candidate-cta-v5\n历史只读兼容模板。",
    "candidate_outro.system.prompt.txt": "VERSION: effect-prompt-candidate-outro-v4\n历史只读兼容模板。",
    "candidate_task.user.prompt.txt": "VERSION: effect-prompt-candidate-task-v9\n渠道：{delivery_channels}\n风格：{visual_style}\n共用约束：{shared_prompt_json}\n产品：{product_context_json}\n任务：{combinations_json}\n重生成：{regeneration_context_json}",
    "fragment_strategy_base.system.prompt.txt": "VERSION: effect-prompt-fragment-strategy-base-v1\n历史只读兼容模板。",
    "fragment_strategy_hook.system.prompt.txt": "VERSION: effect-prompt-fragment-strategy-hook-v1\n历史只读兼容模板。",
    "fragment_strategy_pain.system.prompt.txt": "VERSION: effect-prompt-fragment-strategy-pain-v1\n历史只读兼容模板。",
    "fragment_strategy_product_display.system.prompt.txt": "VERSION: effect-prompt-fragment-strategy-product-display-v1\n历史只读兼容模板。",
    "fragment_strategy_selling_point.system.prompt.txt": "VERSION: effect-prompt-fragment-strategy-selling-point-v1\n历史只读兼容模板。",
    "fragment_strategy_cta.system.prompt.txt": "VERSION: effect-prompt-fragment-strategy-cta-v1\n历史只读兼容模板。",
    "fragment_strategy_outro.system.prompt.txt": "VERSION: effect-prompt-fragment-strategy-outro-v1\n历史只读兼容模板。",
    "fragment_strategy_task.user.prompt.txt": "VERSION: effect-prompt-fragment-strategy-task-v1\n类型：{fragment_type}\n数量：{target_count}\n母版：{bundle_target}\n强制事实：{mandatory_fact_ids_json}\n候选事实：{candidate_facts_json}\n共用约束：{shared_prompt}\n分配哈希：{allocation_hash}",
    "v10_relationship_base.system.prompt.txt": "VERSION: effect-prompt-v10-relationship-base-v2\n历史只读兼容模板。",
    "v10_relationship_task.user.prompt.txt": "类型：{fragment_type}\n数量：{target_count}\n母版：{bundle_target}\n强制事实：{mandatory_fact_ids_json}\n候选事实：{candidate_facts_json}\n共用约束：{shared_prompt}\n分配哈希：{allocation_hash}",
    "v10_coordinate_base.system.prompt.txt": "VERSION: effect-prompt-v10-coordinate-base-v8\n历史只读兼容模板。",
    "v10_coordinate_task.user.prompt.txt": "类型：{fragment_type}\n数量：{target_count}\n事实：{facts_json}\n关系：{relationships_json}\n规则：{fragment_rules}\n共用约束：{shared_prompt}\n关系哈希：{relationship_hash}\n配额：{quota_json}\n关系束：{bundle_ids_json}\n变体：{shared_variant_count}",
    "v10_blueprint_base.system.prompt.txt": "VERSION: effect-prompt-v10-blueprint-base-v5\n历史只读兼容模板。",
    "v10_blueprint_task.user.prompt.txt": "事实：{facts_json}\n关系：{relationships_json}\n坐标：{coordinate_plan_json}\n任务：{tasks_json}\n共用约束：{shared_prompt}\n避重：{avoid_signatures_json}",
}


@lru_cache(maxsize=16)
def load_prompt(name: str) -> str:
    if "/" in name or "\\" in name or not name.endswith(".prompt.txt"):
        raise ValueError("invalid prompt template name")
    if name in _LEGACY_COMPATIBILITY_TEMPLATES:
        return _LEGACY_COMPATIBILITY_TEMPLATES[name]
    return (
        files("effect_prompt_generation.prompts")
        .joinpath(name)
        .read_text(encoding="utf-8")
    )


def load_prompt_version(name: str) -> str:
    match = _VERSION.search(load_prompt(name))
    if match is None:
        raise ValueError(f"prompt template {name} has no VERSION header")
    return match.group(1)


def render_prompt(name: str, **values: str) -> str:
    template = load_prompt(name)
    required = set(_VARIABLE.findall(template))
    missing = sorted(required.difference(values))
    if missing:
        raise ValueError(f"missing prompt template variable: {missing[0]}")
    return _VARIABLE.sub(lambda match: values[match.group(1)], template)
