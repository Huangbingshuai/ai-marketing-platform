"""Create adjacent subtitle cards from one already-synthesized narration clip."""

import hashlib
import math
from typing import Any

from .packaging_provider import PackagingError


# An enumeration comma belongs to the displayed phrase. Sentence punctuation does not.
CAPTION_BREAK_MARKS = frozenset('，,。.!！？?；;：:…')
CLOSING_QUOTES = frozenset('”’」』）》】')


def caption_text_parts(text: str) -> list[str]:
    """Split display text only; narration remains a single voice clip per slot."""
    clauses: list[str] = []
    current: list[str] = []
    pending_break = False
    for char in text:
        if char in CAPTION_BREAK_MARKS:
            pending_break = True
            continue
        if pending_break and char.isspace():
            continue
        if pending_break and char not in CLOSING_QUOTES:
            value = ' '.join(''.join(current).split())
            if value:
                clauses.append(value)
            current = []
            pending_break = False
        current.append(char)
    value = ' '.join(''.join(current).split())
    if value:
        clauses.append(value)
    if not clauses:
        raise PackagingError('口播没有可用的字幕文字')
    return clauses


def caption_boundaries(parts: list[str], duration: float) -> list[float]:
    """Allocate saved voice duration by text length, without media I/O or TTS calls."""
    if not math.isfinite(duration) or duration <= 0:
        raise PackagingError('配音时长无效，不能生成字幕')
    weights = [max(1, len(''.join(part.split()))) for part in parts]
    total = sum(weights)
    minimum = min(.12, duration / (len(parts) * 2))
    ends: list[float] = []
    elapsed = 0
    for index, weight in enumerate(weights[:-1]):
        elapsed += weight
        lower = ends[-1] + minimum if ends else minimum
        upper = duration - (len(parts) - index - 1) * minimum
        target = duration * elapsed / total
        target = max(lower, min(upper, target))
        ends.append(round(target, 6))
    ends.append(duration)
    return ends


def captions_for_voice(line: dict[str, Any], voice: dict[str, Any]) -> list[dict[str, Any]]:
    parts = caption_text_parts(line['text'])
    boundaries = caption_boundaries(parts, float(voice['duration']))
    start = float(voice['start'])
    captions: list[dict[str, Any]] = []
    for index, (part, end) in enumerate(zip(parts, boundaries, strict=True)):
        absolute_end = round(float(voice['start']) + end, 6)
        captions.append({
            'id': 'caption-' + hashlib.sha256(f"{line['id']}:{index}".encode()).hexdigest()[:24],
            'voiceLineId': line['id'],
            'segmentIndex': index,
            'segmentCount': len(parts),
            'text': part,
            'start': start,
            'end': absolute_end,
        })
        start = absolute_end
    return captions
