"""Lossless request-local aliases for long IDs, never for business text or persisted data."""
from __future__ import annotations
from typing import Any
import re

SCALARS = frozenset({'id', 'assetId', 'sourceObjectId', 'sceneAssetId', 'sceneId', 'shotId', 'cueId', 'clipId', 'unitId', 'issueId'})
ARRAYS = frozenset({'assetIds', 'shotIds', 'sourceEventIds', 'eventIds', 'affectedShotIds', 'affectedClipIds', 'clipIds', 'issueIds'})


def rewrite(value: Any, aliases: dict[str, str], field: str = '') -> Any:
    if isinstance(value, dict):
        return {key: rewrite(item, aliases, key) for key, item in value.items()}
    if isinstance(value, list):
        return [aliases.get(item, item) if field in ARRAYS and isinstance(item, str) else rewrite(item, aliases) for item in value]
    if field in SCALARS and isinstance(value, str):
        return aliases.get(value, value)
    return value


def restore_review_text(value: dict[str, Any], aliases: dict[str, str]) -> dict[str, Any]:
    """Restore model-authored review prose only; never touch original text or prompts."""
    if not aliases:
        return value
    pattern = re.compile(r'(?<![A-Za-z0-9_-])(?:' + '|'.join(re.escape(a) for a in sorted(aliases, key=len, reverse=True)) + r')(?![A-Za-z0-9_-])')
    def restore(item: dict[str, Any], fields: tuple[str, ...]) -> None:
        for field in fields:
            if isinstance(item.get(field), str):
                item[field] = pattern.sub(lambda match: aliases[match.group()], item[field])
    restore(value, ('summary',))
    for item in value.get('checks', []):
        restore(item, ('conclusion',))
    for item in value.get('findings', []):
        restore(item, ('title', 'impact', 'suggestedFix'))
    for item in value.get('resolutions', []):
        restore(item, ('explanation',))
    for item in value.get('severityChanges', []):
        restore(item, ('explanation',))
    return value


def compact_references(context: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    identities: set[str] = set()
    def collect(value: Any, field: str = '') -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                collect(item, key)
        elif isinstance(value, list):
            for item in value:
                if field in ARRAYS and isinstance(item, str):
                    identities.add(item)
                else:
                    collect(item)
        elif field in SCALARS and isinstance(value, str):
            identities.add(value)
    collect(context)
    forward: dict[str, str] = {}
    index = 1
    for identity in sorted(identities):
        if len(identity) < 16:
            continue
        while f'REF{index}' in identities:
            index += 1
        forward[identity] = f'REF{index}'
        index += 1
    result: dict[str, Any] = rewrite(context, forward)
    return result, {alias: identity for identity, alias in forward.items()}
