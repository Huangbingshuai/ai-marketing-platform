from __future__ import annotations

import re
from decimal import Decimal

from .models import (
    MAX_PROMPT_DURATION_SECONDS,
    MIN_PROMPT_DURATION_SECONDS,
    MaterialShotBeat,
    MaterialShotPlan,
)

_TIME_RANGE_LINE = re.compile(r"^\s*\d+(?:\.\d+)?\s*[–—-]\s*\d+(?:\.\d+)?\s*秒\s*$")
_FORMAT_LABELS = (
    "目标：",
    "质感：",
    "场景：",
    "光线：",
    "首帧状态：",
    "镜头：",
    "焦点：",
    "驱动：",
    "结果：",
    "同步声：",
)


class ShotPlanCompilationError(ValueError):
    """The model returned a structurally unusable shooting plan."""


def compile_material_shot_plan(
    plan: MaterialShotPlan,
    *,
    target_duration_seconds: int,
) -> str:
    """Compile a semantic-free shooting plan into a provider-ready Prompt.

    The compiler only assigns time ranges and formats fields. It deliberately
    does not infer product meaning, rewrite actions, or add creative content.
    """

    if not (
        MIN_PROMPT_DURATION_SECONDS
        <= target_duration_seconds
        <= MAX_PROMPT_DURATION_SECONDS
    ):
        raise ShotPlanCompilationError("target duration must be between 4 and 15")
    if plan.beats[0].duration_seconds is None and len(plan.beats) > target_duration_seconds:
        raise ShotPlanCompilationError(
            "shot plan cannot contain more beats than available seconds"
        )

    time_ranges = _allocate_time_ranges(
        plan.beats,
        target_duration_seconds=target_duration_seconds,
    )
    lines = [
        "【视频概览】",
        (
            f"目标：{_sentence(plan.overview.visual_intent)} "
            f"质感：{_sentence(plan.overview.visual_style)} "
            f"场景：{_sentence(plan.scene.environment)} "
            f"光线：{_sentence(plan.scene.lighting)} "
            f"首帧状态：{_sentence(plan.scene.initial_state)}"
        ),
        "【逐秒镜头】",
    ]
    for beat, (start, end) in zip(plan.beats, time_ranges, strict=True):
        detail = (
            f"{_sentence(beat.framing)} {_sentence(beat.action)} "
            f"镜头：{_sentence(beat.camera)}"
        )
        if beat.focus:
            detail += f" 焦点：{_sentence(beat.focus)}"
        if beat.motion_source:
            detail += f" 驱动：{_sentence(beat.motion_source)}"
        detail += f" 结果：{_sentence(beat.visible_result)}"
        if beat.sound:
            detail += f" 同步声：{_sentence(beat.sound)}"
        lines.extend((f"{start:g}–{end:g}秒", detail))
    lines.extend(("【结束画面】", _sentence(plan.final_frame)))
    return "\n".join(lines)


def embedding_text_without_format_headers(content: str) -> str:
    """Remove only compiler-owned labels before vector comparison."""

    headers = {"【视频概览】", "【逐秒镜头】", "【结束画面】"}
    lines: list[str] = []
    for line in content.splitlines():
        stripped = line.strip()
        if stripped in headers or _TIME_RANGE_LINE.fullmatch(stripped):
            continue
        for label in _FORMAT_LABELS:
            stripped = stripped.replace(label, " ")
        lines.append(stripped)
    return "\n".join(lines).strip()


def _allocate_time_ranges(
    beats: list[MaterialShotBeat],
    *,
    target_duration_seconds: int,
) -> list[tuple[float, float]]:
    durations = [beat.duration_seconds for beat in beats]
    if any(value is not None for value in durations):
        if any(value is None for value in durations):
            raise ShotPlanCompilationError("shot plan contains mixed duration formats")
        # Integer tenths avoid floating-point drift, without inventing timings.
        ticks = []
        for value in durations:
            tick = Decimal(str(value)) * 10
            if (
                not tick.is_finite()
                or abs(tick - tick.to_integral_value()) > Decimal("0.00000001")
                or tick <= 0
            ):
                raise ShotPlanCompilationError("beat duration must use positive tenths")
            ticks.append(int(tick.to_integral_value()))
        if sum(ticks) != target_duration_seconds * 10:
            raise ShotPlanCompilationError("beat durations must equal target duration")
        result: list[tuple[float, float]] = []
        cursor = 0
        for tick_count in ticks:
            end = cursor + tick_count
            result.append((cursor / 10, end / 10))
            cursor = end
        return result

    # Historical weight-only plans keep their exact original integer allocation.
    weights = [beat.duration_weight for beat in beats]
    remaining = target_duration_seconds - len(beats)
    total_weight = sum(weights)
    extras = [remaining * weight // total_weight for weight in weights]
    remainder = remaining - sum(extras)
    ranked = sorted(
        range(len(beats)),
        key=lambda index: (
            -(remaining * weights[index] % total_weight),
            index,
        ),
    )
    for index in ranked[:remainder]:
        extras[index] += 1

    legacy_result: list[tuple[float, float]] = []
    cursor = 0
    for extra in extras:
        end = cursor + 1 + extra
        legacy_result.append((cursor, end))
        cursor = end
    if cursor != target_duration_seconds:
        raise ShotPlanCompilationError("compiled time ranges do not cover duration")
    return legacy_result


def _sentence(value: str) -> str:
    normalized = " ".join(value.split()).strip()
    return normalized if normalized.endswith(("。", "！", "？", ".", "!", "?")) else f"{normalized}。"
