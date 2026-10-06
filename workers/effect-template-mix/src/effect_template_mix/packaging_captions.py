"""Build subtitles only from source-bound word timestamps, never predicted durations."""

import hashlib
import math
from typing import Any

from .packaging_provider import PackagingError


# An enumeration comma belongs to the displayed phrase. Sentence punctuation does not.
CAPTION_BREAK_MARKS = frozenset('，,。.!！？?；;：:…')
CLOSING_QUOTES = frozenset('”’」』）》】')


def speech_aligned_segment_frames(pcm: bytes, frames: list[int],
                                  speech_starts: list[int] | None = None) -> list[int]:
    """Legacy partition metadata, computed only from explicit synthesis word onsets."""
    if not frames or any(n <= 0 for n in frames) or len(pcm) != sum(frames) * 2:
        raise PackagingError('配音片段时长与合成音频不一致')
    if speech_starts is not None:
        if len(speech_starts) != len(frames) or any(
                not isinstance(onset, int) or isinstance(onset, bool) or not 0 <= onset < count
                for onset, count in zip(speech_starts, frames)):
            raise PackagingError('配音字词时间戳与片段不一致')
        boundaries = [0]
        position = 0
        for index, count in enumerate(frames):
            if index:
                boundaries.append(position + speech_starts[index])
            position += count
        boundaries.append(position)
        return [end - start for start, end in zip(boundaries, boundaries[1:])]
    raise PackagingError('配音缺少字词时间戳，不能按音量预测字幕位置')


def _caption_and_speech_parts(text: str) -> list[tuple[str, str]]:
    """Keep terminal punctuation for each TTS request, but not for its caption."""
    clauses: list[tuple[str, str]] = []
    current: list[str] = []
    spoken: list[str] = []
    pending_break = False
    for char in text:
        if char in CAPTION_BREAK_MARKS:
            if current:
                spoken.append(char)
            pending_break = True
            continue
        if pending_break and char.isspace():
            continue
        if pending_break and char not in CLOSING_QUOTES:
            value = ' '.join(''.join(current).split())
            if value:
                clauses.append((value, ' '.join(''.join(spoken).split())))
            current = []
            spoken = []
            pending_break = False
        current.append(char)
        spoken.append(char)
    value = ' '.join(''.join(current).split())
    if value:
        clauses.append((value, ' '.join(''.join(spoken).split())))
    if not clauses:
        raise PackagingError('口播没有可用的字幕文字')
    return clauses


def caption_text_parts(text: str) -> list[str]:
    return [display for display, _ in _caption_and_speech_parts(text)]


def voice_text_parts(text: str) -> list[str]:
    return [spoken for _, spoken in _caption_and_speech_parts(text)]


def captions_for_voice(line: dict[str, Any], voice: dict[str, Any]) -> list[dict[str, Any]]:
    parts = caption_text_parts(line['text'])
    ranges = voice.get('speechRanges')
    if ranges is None:
        raise PackagingError('口播缺少本次合成的字词时间戳，不能严格对齐字幕；请重新生成该槽位口播')
    if ranges is not None:
        if not isinstance(ranges, list) or len(ranges) != len(parts):
            raise PackagingError('配音语音区间与字幕数量不一致')
        previous_end = 0
        intervals: list[tuple[float, float]] = []
        for row in ranges:
            if not isinstance(row, dict) or set(row) != {'startFrame', 'endFrame'}:
                raise PackagingError('配音语音区间无效')
            begin, end = row['startFrame'], row['endFrame']
            if (any(not isinstance(n, int) or isinstance(n, bool) for n in (begin, end))
                    or not previous_end <= begin < end <= round(float(voice['duration']) * 24000)):
                raise PackagingError('配音语音区间超出音频范围')
            previous_end = end
            offset = float(voice.get('offset', 0))
            intervals.append((begin / 24000 - offset, end / 24000 - offset))
        return [{
            'id': 'caption-' + hashlib.sha256(f"{line['id']}:{index}".encode()).hexdigest()[:24],
            'voiceLineId': line['id'], 'segmentIndex': index, 'segmentCount': len(parts),
            'text': part,
            'start': round(float(voice['start']) + begin, 6),
            'end': round(float(voice['start']) + end, 6),
        } for index, (part, (begin, end)) in enumerate(zip(parts, intervals, strict=True))]
    raise PackagingError('口播缺少本次合成的字词时间戳，不能严格对齐字幕；请重新生成该槽位口播')
