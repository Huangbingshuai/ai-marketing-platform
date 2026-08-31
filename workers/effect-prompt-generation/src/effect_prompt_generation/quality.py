from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Callable

from .models import (
    CreativeCandidate,
    CreativeEvaluation,
    FactVisualStrategy,
    FactVisualUsage,
    InsightApplicationMap,
    InsightField,
)


@dataclass(frozen=True, slots=True)
class RankedCreative:
    candidate: CreativeCandidate
    evaluation: CreativeEvaluation
    quality_score: float
    novelty_score: float
    selection_score: float


@dataclass(frozen=True, slots=True)
class CreativeSelectionResult:
    selected: list[RankedCreative]
    rejected: list[RankedCreative]
    exact_duplicate_count: int


def trigram_dice(left: str, right: str) -> float:
    left_grams = _ngrams(_semantic_text(left), 3)
    right_grams = _ngrams(_semantic_text(right), 3)
    if not left_grams and not right_grams:
        return 1.0
    if not left_grams or not right_grams:
        return 0.0
    return 2.0 * len(left_grams & right_grams) / (len(left_grams) + len(right_grams))


def _semantic_text(value: str) -> str:
    normalized = re.sub(r"\s+", " ", unicodedata.normalize("NFC", value).strip().casefold())
    return "".join(
        character
        for character in normalized
        if not character.isspace()
        and unicodedata.category(character)[0] not in {"P", "S"}
    )


def _ngrams(value: str, size: int) -> set[str]:
    if not value:
        return set()
    if len(value) < size:
        return {value}
    return {value[index : index + size] for index in range(len(value) - size + 1)}


_PRODUCT_RELEVANT_FIELDS = {
    InsightField.PRODUCT_NAME,
    InsightField.PRODUCT_CATEGORY,
    InsightField.CORE_SPECIFICATION,
    InsightField.VISUAL_FEATURES,
    InsightField.CORE_SELLING_POINT,
    InsightField.SECONDARY_SELLING_POINT,
    InsightField.CORE_PAIN_POINT,
    InsightField.DECISION_DRIVER,
    InsightField.USAGE_SCENARIO,
    InsightField.PURCHASE_SCENARIO,
    InsightField.EMOTIONAL_SCENARIO,
}

_GENERIC_STYLE_PHRASES = (
    "电影级",
    "电影感",
    "高级感",
    "高级质感",
    "商业广告质感",
    "大片质感",
    "暖色光线",
    "暖色调",
    "浅景深",
    "缓慢推进",
)

_PURPOSE_ONLY_PHRASES = (
    "展示产品效果",
    "展示产品品质",
    "体现产品品质",
    "突出产品卖点",
    "突出核心卖点",
    "建立信任感",
    "营造高级感",
)

_ACTION_VERB_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"切(?:开|下|成|出|片|段|块|丁|丝|薄片|厚片|制)|下刀"),
    re.compile(r"夹起|夹取|拿起|拾起"),
    re.compile(r"摆盘|装盘|码放"),
    re.compile(r"拆(?:开)?包装|撕开|开袋"),
    re.compile(r"放入|加入|铺在|拌入"),
    re.compile(r"蒸制|上锅蒸|放入蒸笼|揭开锅盖"),
    re.compile(r"煎制|下锅煎|翻煎"),
    re.compile(r"翻炒|下锅炒|炒制"),
    re.compile(r"水煮|煮制|下锅煮"),
    re.compile(r"烘烤|烤制|放入烤箱"),
    re.compile(r"端上|递给|送到餐桌"),
    re.compile(r"品尝|尝一口|入口|咬下|送入口中|放入口中"),
    re.compile(r"观察|查看|端详"),
)
_COOKING_METHOD_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"蒸制|上锅蒸|蒸笼"),
    re.compile(r"煎制|下锅煎|翻煎"),
    re.compile(r"翻炒|下锅炒|炒制"),
    re.compile(r"水煮|煮制|下锅煮"),
    re.compile(r"烘烤|烤制|烤箱"),
)
_SEQUENCE_CONNECTOR = re.compile(r"随后|接着|然后|再(?:将|把|用|切|夹|放|端|取)|最后|继而")
_RAW_FOOD = re.compile(r"生(?:的|制|鲜)?(?:腊肠|香肠)|未(?:经烹制|煮熟|蒸熟|熟制)|未经加热")
_COOKED_FOOD = re.compile(
    r"蒸熟|煮熟|煎熟|炒熟|烤熟|焖熟|熟制后|加热完成|蒸制完成|煮制完成|煎制完成|炒制完成|烤制完成|焖制完成|加盖焖|小火焖"
)
_TASTING_ACTION = re.compile(r"品尝|尝一口|入口|咬下|送入口中|放入口中")
_IMPOSSIBLE_COOL_VAPOR = re.compile(
    r"(?:腊肠|香肠|切片|食物|产品|蒸屉|蒸笼|蒸锅|锅盖).{0,16}(?:冒出|升起|散发|腾起)(?:阵阵|一缕|丝丝)?(?:凉气|冷气)"
    r"|(?:凉气|冷气).{0,16}(?:从|围绕)(?:腊肠|香肠|切片|食物|产品|蒸屉|蒸笼|蒸锅|锅盖)"
)
_READY_TO_EAT = re.compile(r"即食|开袋即食|熟制品|可直接食用|无需加热")
_COOK_REQUIRED = re.compile(r"需(?:要)?(?:熟制|煮熟|蒸熟|加热)|食用前(?:需|须)加热|非即食|生制")
_COOK_REQUIRED_CATEGORY = re.compile(r"腊肠|腊肉|生香肠")
_PREPARATION_ACTION = re.compile(r"拆(?:开)?包装|撕开|开袋|取出|切片|切开|下刀")
_FINISHED_DISH_PLACEMENT = re.compile(
    r"(?:放|摆|铺|码)(?:在|到|入|上).{0,10}(?:成品饭|熟米饭|热米饭|做好的饭|刚焖好的?饭|成品菜|做好的菜|热气腾腾的?煲仔饭|做好的?煲仔饭|盛好的?煲仔饭|刚焖好的?煲仔饭|刚收完汁的?煲仔饭|刚离火的?(?:米饭|煲仔饭)|刚蒸好的?(?:米饭|饭|煲仔饭))"
)
_EXPLICIT_COOKED_PRODUCT = re.compile(
    r"(?:蒸熟|煮熟|煎熟|炒熟|烤熟|焖熟|熟制(?:完成|后)?|加热完成)(?:的)?(?:广式)?(?:腊肠|香肠)"
    r"|(?:广式)?(?:腊肠|香肠).{0,8}(?:已经|已)?(?:蒸熟|煮熟|煎熟|炒熟|烤熟|焖熟|熟制(?:完成)?|加热完成)"
)
_EXPLICIT_MINUTE_WAIT = re.compile(r"(?:几|数|十几|几十|\d+)\s*分钟(?:后|左右|完成|至|再|，|,)?")
_LONG_COOK_COMPLETION = re.compile(
    r"蒸熟|煮熟|焖熟|烤熟|熟制完成|加热完成|蒸制完成|煮制完成|焖制完成|加盖.{0,12}(?:焖至|蒸至|煮至).{0,6}熟"
)
_RAPID_FULL_COOK = re.compile(
    r"(?:整根)?(?:广式)?(?:腊肠|香肠).{0,16}(?:放入|投入|下入).{0,10}(?:沸水|蒸锅|蒸笼|锅中).{0,18}(?:片刻|瞬间|转眼|马上|立即|很快|眨眼间|不一会儿).{0,18}(?:蒸熟|煮熟|熟透|成品|出锅|捞出|蒸好|煮好)"
)
_UNSUPPORTED_SELF_ROTATION = re.compile(
    r"(?:腊肠|香肠|产品|整根).{0,10}(?:自行|自己|无外力|悬空)(?:缓慢|快速|持续)?(?:旋转|转动|翻面)"
    r"|(?:自行|自己|无外力|悬空)(?:缓慢|快速|持续)?(?:旋转|转动|翻面).{0,10}(?:腊肠|香肠|产品|整根)"
)
_CHOPSTICKS_WHOLE_SAUSAGE = re.compile(
    r"(?:筷子|木筷).{0,12}(?:夹起|夹住|夹取|提起).{0,8}(?:一整根|整根)(?:广式)?(?:腊肠|香肠)"
    r"|(?:一整根|整根)(?:广式)?(?:腊肠|香肠).{0,12}(?:被|用)(?:筷子|木筷).{0,8}(?:夹起|夹住|夹取|提起)"
)
_ABSTRACT_VISUAL_PROOF = re.compile(
    r"(?:真空|密封|封口|包装|袋装|外观|形态).{0,12}(?:锁鲜|保鲜)"
    r"|(?:锁鲜|保鲜).{0,12}(?:真空|密封|封口|包装|袋装|外观|形态)"
    r"|(?:肉纤维|粉质|切面|纹理|光泽|弹性|颜色).{0,14}(?:无淀粉|零添加|无添加|纯天然|配方|工艺|比例)"
    r"|(?:无淀粉|零添加|无添加|纯天然|配方|工艺|比例).{0,14}(?:肉纤维|粉质|切面|纹理|光泽|弹性|颜色)"
)


def normalize_creative_signature(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\s\W_]+", "", normalized)[:240] or "empty"


def creative_soft_warnings(candidate: CreativeCandidate) -> list[str]:
    """Return deterministic quality hints that must never reject a creative."""

    corpus = "|".join(
        (
            candidate.content,
            candidate.dimensions.camera,
            candidate.dimensions.emotion,
        )
    )
    warnings: list[str] = []
    generic_hits = {phrase for phrase in _GENERIC_STYLE_PHRASES if phrase in corpus}
    if len(generic_hits) >= 3:
        warnings.append("GENERIC_STYLE_STACKING")
    if any(phrase in corpus for phrase in _PURPOSE_ONLY_PHRASES):
        warnings.append("PURPOSE_SENTENCE_INSTEAD_OF_VISIBLE_ACTION")
    return warnings


def creative_execution_findings(
    candidate: CreativeCandidate,
    *,
    target_duration_seconds: int | None,
    application: InsightApplicationMap | None = None,
) -> tuple[list[str], list[str]]:
    corpus = "|".join(
        (
            candidate.creative_core,
            candidate.dimensions.narrative,
            candidate.dimensions.product_relation,
            candidate.content,
        )
    )
    hard_issues: list[str] = []
    warnings: list[str] = []
    if _IMPOSSIBLE_COOL_VAPOR.search(corpus):
        hard_issues.append("FOOD_PHYSICS_CONFLICT")
    if _UNSUPPORTED_SELF_ROTATION.search(candidate.content):
        hard_issues.append("UNSUPPORTED_OBJECT_MOTION")
    if _CHOPSTICKS_WHOLE_SAUSAGE.search(candidate.content):
        warnings.append("IMPLAUSIBLE_PRODUCT_HANDLING")
    food_text = candidate.content
    taste_match = _TASTING_ACTION.search(food_text)
    raw_match = _RAW_FOOD.search(food_text)
    if taste_match is not None and raw_match is not None:
        cooked_before_taste = any(
            match.start() < taste_match.start() for match in _COOKED_FOOD.finditer(food_text)
        )
        if not cooked_before_taste:
            hard_issues.append("FOOD_STATE_CONFLICT")
    if application is not None and _application_requires_cooking(application):
        preparation_match = _PREPARATION_ACTION.search(food_text)
        finished_dish_match = _FINISHED_DISH_PLACEMENT.search(food_text)
        terminal_match = taste_match or finished_dish_match
        if preparation_match is not None and terminal_match is not None:
            cooking_matches = list(_COOKED_FOOD.finditer(food_text))
            explicit_cooked_product = _EXPLICIT_COOKED_PRODUCT.search(food_text)
            cooked_in_time = (
                (
                    explicit_cooked_product is not None
                    and explicit_cooked_product.start() < terminal_match.start()
                )
                or any(
                    preparation_match.start() < match.start() < terminal_match.start()
                    for match in cooking_matches
                )
                if taste_match is not None
                else (
                    explicit_cooked_product is not None
                    and explicit_cooked_product.start() < terminal_match.start()
                )
                or any(match.start() > terminal_match.start() for match in cooking_matches)
            )
            if not cooked_in_time:
                hard_issues.append("FOOD_STATE_CONFLICT")

    if target_duration_seconds is not None and target_duration_seconds <= 30:
        action_count = sum(bool(pattern.search(corpus)) for pattern in _ACTION_VERB_PATTERNS)
        cooking_method_count = sum(
            bool(pattern.search(corpus)) for pattern in _COOKING_METHOD_PATTERNS
        )
        connector_count = len(_SEQUENCE_CONNECTOR.findall(candidate.content))
        preparation_match = _PREPARATION_ACTION.search(candidate.content)
        long_completion = _LONG_COOK_COMPLETION.search(candidate.content)
        impossible_wait = bool(_EXPLICIT_MINUTE_WAIT.search(candidate.content))
        continuous_full_cook = bool(
            target_duration_seconds > 15
            and preparation_match is not None
            and long_completion is not None
            and preparation_match.start() < long_completion.start()
        )
        rapid_full_cook = bool(_RAPID_FULL_COOK.search(candidate.content))
        if impossible_wait or continuous_full_cook or rapid_full_cook:
            hard_issues.append("REAL_TIME_EXCEEDS_TARGET")
        very_short_duration = target_duration_seconds <= 8
        short_duration = target_duration_seconds <= 15
        if (
            short_duration
            and (action_count >= 6 or cooking_method_count >= 3 or connector_count >= 5)
        ) or (
            not short_duration
            and (action_count >= 8 or cooking_method_count >= 3 or connector_count >= 6)
        ):
            hard_issues.append("ACTION_CHAIN_OVERLOAD")
        elif (
            very_short_duration
            and (action_count >= 3 or cooking_method_count >= 2 or connector_count >= 2)
        ) or (
            short_duration
            and (action_count >= 4 or cooking_method_count >= 2 or connector_count >= 3)
        ) or (
            not short_duration
            and (action_count >= 6 or cooking_method_count >= 2 or connector_count >= 4)
        ):
            warnings.append("DURATION_TOO_DENSE")
    return list(dict.fromkeys(hard_issues)), list(dict.fromkeys(warnings))


def validate_creative_evaluation(
    candidate: CreativeCandidate,
    evaluation: CreativeEvaluation,
    application: InsightApplicationMap,
    *,
    target_duration_seconds: int | None = None,
    contextual_fact_ids: Sequence[str] = (),
    fact_visual_strategy: FactVisualStrategy | None = None,
) -> CreativeEvaluation:
    if evaluation.slot_id != candidate.slot_id:
        raise ValueError("creative evaluation changed slotId")
    declared = set(candidate.declared_fact_ids)
    contextual = {
        fact_id
        for fact_id in contextual_fact_ids
        if fact_id in application.by_id
    }
    allowed_evidence = declared | contextual
    content_text = _normalized_evidence_text(candidate.content)
    valid_evidence = []
    evidenced_fact_ids: set[str] = set()
    evidence_metadata_codes = {
        "FACT_EVIDENCE_NOT_IN_CONTENT",
        "UNKNOWN_OR_UNDECLARED_FACT",
    }
    ai_reported_abstract_proof = "ABSTRACT_FACT_VISUAL_PROOF" in evaluation.hard_issues
    issues = [
        issue
        for issue in evaluation.hard_issues
        if issue not in {*evidence_metadata_codes, "ABSTRACT_FACT_VISUAL_PROOF"}
    ]
    warnings = [*evaluation.warnings, *creative_soft_warnings(candidate)]
    warnings.extend(
        issue for issue in evaluation.hard_issues if issue in evidence_metadata_codes
    )
    for evidence in evaluation.fact_evidence:
        fact = application.by_id.get(evidence.fact_id)
        if fact is None or evidence.fact_id not in allowed_evidence:
            warnings.append("UNKNOWN_OR_UNDECLARED_FACT")
            continue
        if _normalized_evidence_text(evidence.evidence_text) not in content_text:
            warnings.append("FACT_EVIDENCE_NOT_IN_CONTENT")
            continue
        if evidence.fact_id not in contextual and not _evidence_supports_fact(
            evidence.evidence_text,
            fact.value,
            field=fact.field,
        ):
            warnings.append("FACT_EVIDENCE_MISMATCH")
            continue
        if evidence.fact_id in evidenced_fact_ids:
            continue
        evidenced_fact_ids.add(evidence.fact_id)
        valid_evidence.append(evidence)
    relevant = [
        evidence
        for evidence in valid_evidence
        if application.by_id[evidence.fact_id].field in _PRODUCT_RELEVANT_FIELDS
    ]
    if fact_visual_strategy is not None:
        policy_by_id = fact_visual_strategy.by_id
        non_visual_fact_used = any(
            (policy := policy_by_id.get(evidence.fact_id)) is not None
            and policy.visual_usage
            in {
                FactVisualUsage.CONTEXT_ONLY,
                FactVisualUsage.TEXT_ONLY,
                FactVisualUsage.FORBIDDEN_VISUAL_PROOF,
            }
            for evidence in valid_evidence
        )
        if non_visual_fact_used and (
            ai_reported_abstract_proof or _ABSTRACT_VISUAL_PROOF.search(candidate.content)
        ):
            issues.append("ABSTRACT_FACT_VISUAL_PROOF")
    if not relevant:
        issues.append("MISSING_PRODUCT_RELATION")
    if evaluation.scores.product_relevance < 60:
        issues.append("LOW_PRODUCT_RELEVANCE")
    if evaluation.scores.creative_coherence < 50:
        issues.append("DIMENSION_CONTENT_CONFLICT")
    if evaluation.scores.visual_executability < 50:
        issues.append("VISUALLY_UNEXECUTABLE")
    execution_issues, execution_warnings = creative_execution_findings(
        candidate,
        target_duration_seconds=target_duration_seconds,
        application=application,
    )
    issues.extend(execution_issues)
    warnings.extend(execution_warnings)
    semantic = normalize_creative_signature(candidate.creative_core)
    visual = normalize_creative_signature(
        "|".join(
            (
                candidate.dimensions.scene,
                candidate.dimensions.persona,
                candidate.dimensions.product_relation,
                candidate.dimensions.camera,
            )
        )
    )
    return evaluation.model_copy(
        update={
            "fact_evidence": valid_evidence,
            "realized_fact_ids": [item.fact_id for item in valid_evidence],
            "semantic_signature": semantic,
            "visual_signature": visual,
            "hard_issues": list(dict.fromkeys(issues)),
            "warnings": list(dict.fromkeys(warnings)),
        }
    )


def select_creatives(
    candidates: list[CreativeCandidate],
    evaluations: list[CreativeEvaluation],
    *,
    target_count: int,
    novelty_resolver: Callable[[RankedCreative, RankedCreative], float] | None = None,
    fixed_novelty_resolver: Callable[[RankedCreative], float] | None = None,
    dimension_gain_resolver: Callable[[RankedCreative, list[RankedCreative]], int]
    | None = None,
    required_fact_ids: Sequence[str] = (),
    fixed_covered_fact_ids: Sequence[str] = (),
    quality_weight: float = 0.8,
    novelty_weight: float = 0.2,
) -> CreativeSelectionResult:
    candidate_by_id = {item.slot_id: item for item in candidates}
    ranked = [
        RankedCreative(
            candidate=candidate_by_id[item.slot_id],
            evaluation=item,
            quality_score=_selection_quality_score(item),
            novelty_score=100.0,
            selection_score=(
                _selection_quality_score(item) * quality_weight
                + 100.0 * novelty_weight
            ),
        )
        for item in evaluations
        if item.slot_id in candidate_by_id and not item.hard_issues
    ]
    exact_duplicate_count = 0
    unique: list[RankedCreative] = []
    content_seen: set[str] = set()
    creative_seen: set[tuple[str, ...]] = set()
    for item in sorted(ranked, key=lambda row: row.candidate.ordinal):
        content_signature = normalize_creative_signature(item.candidate.content)
        creative_signature = (
            normalize_creative_signature(item.candidate.creative_core),
            normalize_creative_signature(item.candidate.dimensions.narrative),
            normalize_creative_signature(item.candidate.dimensions.scene),
            normalize_creative_signature(item.candidate.dimensions.persona),
            normalize_creative_signature(item.candidate.dimensions.product_relation),
            normalize_creative_signature(item.candidate.dimensions.camera),
            normalize_creative_signature(item.candidate.dimensions.emotion),
        )
        if content_signature in content_seen or creative_signature in creative_seen:
            exact_duplicate_count += 1
            continue
        content_seen.add(content_signature)
        creative_seen.add(creative_signature)
        unique.append(item)

    selected: list[RankedCreative] = []
    remaining = list(unique)
    resolve_novelty = novelty_resolver or _creative_novelty
    novelty_by_id = {
        item.candidate.slot_id: (
            fixed_novelty_resolver(item)
            if fixed_novelty_resolver is not None
            else 100.0
        )
        for item in remaining
    }
    uncovered_required = set(required_fact_ids) - set(fixed_covered_fact_ids)
    while remaining and len(selected) < target_count:
        scored: list[RankedCreative] = []
        for item in remaining:
            novelty = novelty_by_id[item.candidate.slot_id]
            scored.append(
                RankedCreative(
                    candidate=item.candidate,
                    evaluation=item.evaluation,
                    quality_score=item.quality_score,
                    novelty_score=novelty,
                    selection_score=round(
                        item.quality_score * quality_weight + novelty * novelty_weight,
                        4,
                    ),
                )
            )
        coverage_candidates = [
            row
            for row in scored
            if uncovered_required.intersection(row.evaluation.realized_fact_ids)
        ]
        best = max(
            coverage_candidates or scored,
            key=lambda row: (
                row.selection_score,
                dimension_gain_resolver(row, selected)
                if dimension_gain_resolver is not None
                else 0,
                row.quality_score,
                -row.candidate.ordinal,
            ),
        )
        selected.append(best)
        uncovered_required.difference_update(best.evaluation.realized_fact_ids)
        remaining = [
            item
            for item in remaining
            if item.candidate.slot_id != best.candidate.slot_id
        ]
        for item in remaining:
            slot_id = item.candidate.slot_id
            novelty_by_id[slot_id] = min(
                novelty_by_id[slot_id],
                resolve_novelty(item, best),
            )
    selected_ids = {item.candidate.slot_id for item in selected}
    rejected = [item for item in ranked if item.candidate.slot_id not in selected_ids]
    return CreativeSelectionResult(
        selected=selected,
        rejected=rejected,
        exact_duplicate_count=exact_duplicate_count,
    )


def _selection_quality_score(evaluation: CreativeEvaluation) -> float:
    penalty = 0.0
    if "DURATION_TOO_DENSE" in evaluation.warnings:
        penalty += 8.0
    if "DURATION_TOO_SPARSE" in evaluation.warnings:
        penalty += 4.0
    return max(0.0, round(evaluation.scores.overall_quality - penalty, 4))


def _creative_novelty(left: RankedCreative, right: RankedCreative) -> float:
    semantic = trigram_dice(left.candidate.content, right.candidate.content)
    left_visual = left.candidate.dimensions
    right_visual = right.candidate.dimensions
    visual = (
        sum(
            1
            for left_value, right_value in (
                (left_visual.narrative, right_visual.narrative),
                (left_visual.scene, right_visual.scene),
                (left_visual.persona, right_visual.persona),
                (left_visual.product_relation, right_visual.product_relation),
                (left_visual.camera, right_visual.camera),
                (left_visual.emotion, right_visual.emotion),
            )
            if normalize_creative_signature(left_value)
            == normalize_creative_signature(right_value)
        )
        / 6
    )
    base_novelty = 100.0 * (1.0 - max(semantic, visual))
    left_profile = left.evaluation.semantic_profile
    right_profile = right.evaluation.semantic_profile
    if left_profile is None or right_profile is None:
        return round(base_novelty, 4)
    pairs = (
        (left_profile.narrative_family, right_profile.narrative_family),
        (left_profile.scene_family, right_profile.scene_family),
        (left_profile.persona_family, right_profile.persona_family),
        (left_profile.product_action_family, right_profile.product_action_family),
        (left_profile.camera_family, right_profile.camera_family),
        (left_profile.emotion_family, right_profile.emotion_family),
    )
    same = sum(
        normalize_creative_signature(left_value)
        == normalize_creative_signature(right_value)
        for left_value, right_value in pairs
    )
    cluster_novelty = 100.0 * (1.0 - same / len(pairs))
    return round(0.70 * base_novelty + 0.30 * cluster_novelty, 4)


def _normalized_evidence_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[\s\W_]+", "", normalized)


def _evidence_supports_fact(
    evidence_text: str,
    fact_value: str,
    *,
    field: InsightField,
) -> bool:
    evidence = normalize_creative_signature(evidence_text)
    fact = normalize_creative_signature(fact_value)
    if not evidence or not fact:
        return False
    if field in {InsightField.PRODUCT_NAME, InsightField.PRODUCT_CATEGORY}:
        return fact in evidence or evidence in fact
    generic_short_evidence = {"家庭", "厨房", "产品", "场景", "人群", "用户"}
    if fact in evidence or (
        len(evidence) >= 3
        and evidence not in generic_short_evidence
        and evidence in fact
    ):
        return True
    evidence_bigrams = _ngrams(evidence, 2)
    fact_bigrams = _ngrams(fact, 2)
    if (
        len(evidence) < 3
        or evidence in generic_short_evidence
        or not evidence_bigrams
        or not fact_bigrams
    ):
        return False
    overlap = len(evidence_bigrams & fact_bigrams)
    return overlap >= 1 and overlap / min(len(evidence_bigrams), len(fact_bigrams)) >= 0.5


def _application_requires_cooking(application: InsightApplicationMap) -> bool:
    values = "|".join(fact.value for fact in application.usable)
    if _READY_TO_EAT.search(values):
        return False
    if _COOK_REQUIRED.search(values):
        return True
    identity = "|".join(
        fact.value
        for fact in application.usable
        if fact.field in {InsightField.PRODUCT_NAME, InsightField.PRODUCT_CATEGORY}
    )
    return bool(_COOK_REQUIRED_CATEGORY.search(identity))
