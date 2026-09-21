"""Explicitly authorized, single-node paid probe. Never claims or queues a Run.

Read one frozen {snapshot, checkpoint} from stdin. Reuse saved vision, run only
script planning/audit, and save the candidate to --output for later node checks.
No TTS, music, API writeback, WorkingArtifact confirmation, or automatic retries.
"""
import argparse
import asyncio
import hashlib
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from effect_template_mix.config import get_settings
from effect_template_mix.packaging import plan_script
from effect_template_mix.packaging_provider import PackagingError
from effect_template_mix.provider import ArkProvider, ProviderError

T = TypeVar('T', bound=BaseModel)


class ProbeArk(ArkProvider):
    """Keep normalized business drafts/reviews as local evidence, never raw HTTP responses."""
    output: Path
    sequence: int = 0

    async def structured(self, content: list[dict[str, Any]], output: type[T], name: str, *,
                         max_output_tokens: int, max_attempts: int = 2) -> T:
        result = await super().structured(content, output, name,
            max_output_tokens=max_output_tokens, max_attempts=max_attempts)
        self.sequence += 1
        kind = 'draft' if name == 'packaging_script' else 'review'
        target = self.output.with_name(f'{self.output.stem}-{self.sequence}-{kind}.json')
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('x', encoding='utf-8') as file:
            json.dump(result.model_dump(), file, ensure_ascii=False)
        return result


async def run(output: Path) -> None:
    data = json.load(sys.stdin)
    snapshot, checkpoint = data['snapshot'], data['checkpoint']
    if not checkpoint.get('vision'):
        raise PackagingError('缺少已保存的视觉理解，不会自动调用视觉模型')
    if output.exists():
        raise PackagingError('输出文件已存在，拒绝覆盖或重复测试')
    settings = get_settings()
    ark = ProbeArk(settings.ark_base_url, settings.ark_api_key.get_secret_value(), settings.model,
        settings.ark_timeout_seconds, settings.ark_max_output_tokens, settings.ark_reasoning_effort)
    ark.output = output
    calls = 0

    async def guard() -> None:
        nonlocal calls
        calls += 1
        if calls > 4:
            raise PackagingError('口播节点测试请求数超过上限')

    start = time.monotonic()
    try:
        result = await plan_script(ark, snapshot, checkpoint['vision'], guard)
        value = result.model_dump()
        encoded = json.dumps(value, ensure_ascii=False).encode('utf-8')
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as file:
            file.write(encoded)
        print(json.dumps({'status': 'PASSED', 'stage': 'SCRIPT', 'calls': calls,
            'elapsedSeconds': round(time.monotonic() - start, 3), 'lines': len(result.lines),
            'sourceTimelineHash': snapshot['sourceTimelineHash'],
            'resultHash': hashlib.sha256(encoded).hexdigest()}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'status': 'FAILED', 'stage': 'SCRIPT', 'calls': calls,
            'elapsedSeconds': round(time.monotonic() - start, 3),
            'error': str(exc) if isinstance(exc, (PackagingError, ProviderError)) else type(exc).__name__,
            'causeType': type(exc.__cause__).__name__ if exc.__cause__ else None}, ensure_ascii=False))
        raise SystemExit(1) from None
    finally:
        await ark.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-paid', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.allow_paid:
        parser.error('必须先获得本次单节点付费授权，再显式传 --allow-paid')
    logging.basicConfig(level=logging.INFO)
    logging.getLogger('httpx').setLevel(logging.WARNING)
    asyncio.run(run(args.output))
