"""Opt-in paid vision-only probe using a frozen input; no task or checkpoint writes."""
import argparse
import asyncio
import hashlib
import json
import logging
import sys
import tempfile
import time
from pathlib import Path
from uuid import UUID

import httpx

from effect_template_mix.config import get_settings
from effect_template_mix.packaging import understand_frames
from effect_template_mix.packaging_media import analysis_preview
from effect_template_mix.packaging_provider import PackagingError
from effect_template_mix.provider import ArkProvider


async def run(output: Path, api_base: str, project_id: str) -> None:
    snapshot = json.load(sys.stdin)['snapshot']
    project_id = str(UUID(project_id))
    output.parent.mkdir(parents=True, exist_ok=True)
    # Reserve before any paid call; even an ambiguous failure must use a new output.
    with output.with_suffix('.started').open('x', encoding='utf-8') as marker:
        marker.write(snapshot['sourceTimelineHash'])
    if output.exists():
        raise PackagingError('输出已存在，不重复调用')
    settings = get_settings()
    ark = ArkProvider(settings.ark_base_url, settings.ark_api_key.get_secret_value(), settings.model,
        settings.ark_timeout_seconds, settings.ark_max_output_tokens, settings.ark_reasoning_effort)
    calls = 0
    async def guard() -> None:
        nonlocal calls
        calls += 1
        if calls > 16:
            raise PackagingError('视觉测试请求超过上限')
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix='packaging-vision-probe-') as temp:
            directory = Path(temp)
            paths: dict[str, Path] = {}
            async with httpx.AsyncClient(timeout=120) as client:
                for clip in snapshot['clips']:
                    file_id = str(UUID(clip['fileObjectId']))
                    if file_id in paths:
                        continue
                    path = directory / f'{len(paths)}.mp4'
                    url = f'{api_base.rstrip("/")}/projects/{project_id}/file-objects/{file_id}/content'
                    async with client.stream('GET', url) as response:
                        if response.is_error:
                            raise PackagingError(f'素材读取失败 HTTP {response.status_code}')
                        size = 0
                        with path.open('wb') as file:
                            async for chunk in response.aiter_bytes():
                                size += len(chunk)
                                if size > 100_000_000:
                                    raise PackagingError('素材超过探针容量')
                                file.write(chunk)
                    paths[file_id] = path
            frames = await analysis_preview(snapshot, paths, directory)
            vision = await understand_frames(ark, snapshot, frames, guard)
            encoded = json.dumps({'snapshot': snapshot, 'checkpoint': {'vision': vision}}, ensure_ascii=False).encode()
            with output.open('xb') as file:
                file.write(encoded)
            print(json.dumps({'status': 'PASSED', 'stage': 'VISION', 'calls': calls,
                'elapsedSeconds': round(time.monotonic() - started, 3), 'frames': len(frames),
                'resultHash': hashlib.sha256(encoded).hexdigest()}))
    except Exception as exc:
        print(json.dumps({'status': 'FAILED', 'stage': 'VISION', 'calls': calls,
            'elapsedSeconds': round(time.monotonic() - started, 3), 'errorType': type(exc).__name__}))
        raise SystemExit(1) from None
    finally:
        await ark.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-paid', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--api-base', required=True)
    parser.add_argument('--project-id', required=True)
    args = parser.parse_args()
    if not args.allow_paid:
        parser.error('需先取得单节点付费授权，再传 --allow-paid')
    logging.basicConfig(level=logging.INFO)
    logging.getLogger('httpx').setLevel(logging.WARNING)
    asyncio.run(run(args.output, args.api_base, args.project_id))
