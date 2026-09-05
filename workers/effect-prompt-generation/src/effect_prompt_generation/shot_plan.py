from __future__ import annotations

import re

from .models import MaterialShotBeat, MaterialShotPlan

_TIME_RANGE_LINE = re.compile(r"^\s*\d+\s*[–—-]\s*\d+\s*秒\s*$")
_FORMAT_LABELS = (
    "画面目标：",
    "整体质感：",
    "声音方向：",
    "环境：",
    "光线：",
    "首帧状态：",
    "景别与角度：",
    "画面动作：",
    "镜头执行：",
    "可见结果：",
    "逐字台词：",
    "声音：",
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

    if not 4 <= target_duration_seconds <= 30:
        raise ShotPlanCompilationError("target duration must be between 4 and 30")
    if len(plan.beats) > target_duration_seconds:
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
            f"画面目标：{_sentence(plan.overview.visual_intent)} "
            f"整体质感：{_sentence(plan.overview.visual_style)} "
            f"声音方向：{_sentence(plan.overview.audio_direction)}"
        ),
        "【场景与光线】",
        (
            f"环境：{_sentence(plan.scene.environment)} "
            f"光线：{_sentence(plan.scene.lighting)} "
            f"首帧状态：{_sentence(plan.scene.initial_state)}"
        ),
        "【逐秒镜头】",
    ]
    for beat, (start, end) in zip(plan.beats, time_ranges, strict=True):
        detail = (
            f"景别与角度：{_sentence(beat.framing)} "
            f"画面动作：{_sentence(beat.action)} "
            f"镜头执行：{_sentence(beat.camera)} "
            f"可见结果：{_sentence(beat.visible_result)}"
        )
        if beat.dialogue:
            detail += f" 逐字台词：“{_strip_dialogue_quotes(beat.dialogue)}”。"
        if beat.sound:
            detail += f" 声音：{_sentence(beat.sound)}"
        lines.extend((f"{start}–{end}秒", detail))
    lines.extend(("【结束画面】", _sentence(plan.final_frame)))
    return "\n".join(lines)


def embedding_text_without_format_headers(content: str) -> str:
    """Remove only compiler-owned labels before vector comparison."""

    headers = {"【视频概览】", "【场景与光线】", "【逐秒镜头】", "【结束画面】"}
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
) -> list[tuple[int, int]]:
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

    result: list[tuple[int, int]] = []
    cursor = 0
    for extra in extras:
        end = cursor + 1 + extra
        result.append((cursor, end))
        cursor = end
    if cursor != target_duration_seconds:
        raise ShotPlanCompilationError("compiled time ranges do not cover duration")
    return result


def _sentence(value: str) -> str:
    normalized = " ".join(value.split()).strip()
    return normalized if normalized.endswith(("。", "！", "？", ".", "!", "?")) else f"{normalized}。"


def _strip_dialogue_quotes(value: str) -> str:
    return value.strip().strip("“”\"'‘’").rstrip("。！？.!?")
