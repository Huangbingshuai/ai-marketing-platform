"""Opt-in single voice-node probe, reusing a passed script. No music or task writes."""
import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path

from effect_template_mix.config import get_settings
from effect_template_mix.packaging import ScriptOutput, script_structure_issues
from effect_template_mix.packaging_media import pcm_wav
from effect_template_mix.packaging_provider import PackagingError, PackagingProvider


async def run(script_path: Path, output: Path) -> None:
    snapshot = json.load(sys.stdin)['snapshot']
    script = ScriptOutput.model_validate_json(script_path.read_bytes())
    if script_structure_issues(script, snapshot):
        raise PackagingError('口播结构预检未通过，不调用配音')
    if output.exists():
        raise PackagingError('本轮输出目录已存在，拒绝重复付费测试')
    output.mkdir(parents=True)
    settings = get_settings()
    provider = PackagingProvider(settings.tts_api_key.get_secret_value(), settings.tts_speaker,
        settings.tts_resource_id, settings.music_access_key.get_secret_value(),
        settings.music_secret_key.get_secret_value(), settings.music_action)
    calls = 0
    start = time.monotonic()
    results = []
    try:
        provider.require_configuration()
        for index, line in enumerate(script.lines):
            before = time.monotonic()
            calls += 1
            wav, duration = pcm_wav(await provider.voice(line.text))
            target = output / f'{line.id}.wav'
            target.write_bytes(wav)
            limit = script.lines[index + 1].start if index + 1 < len(script.lines) else snapshot['duration']
            row = {'id': line.id, 'start': line.start, 'duration': duration, 'limit': limit,
                'elapsedSeconds': round(time.monotonic() - before, 3), 'sha256': hashlib.sha256(wav).hexdigest()}
            results.append(row)
            print(json.dumps({'stage': 'VOICE', **row}, ensure_ascii=False), flush=True)
            if line.start + duration > limit:
                raise PackagingError('真实配音超出可用时间，停止后续句子，不截断音频')
        status, error = 'PASSED', None
    except Exception as exc:
        status = 'FAILED'
        error = str(exc) if isinstance(exc, PackagingError) else type(exc).__name__
    finally:
        await provider.close()
    summary = {'stage': 'VOICE', 'status': status, 'error': error, 'calls': calls,
        'elapsedSeconds': round(time.monotonic() - start, 3), 'voices': results}
    (output / 'result.json').write_text(json.dumps(summary, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({k: v for k, v in summary.items() if k != 'voices'}, ensure_ascii=False))
    if status != 'PASSED':
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-paid', action='store_true')
    parser.add_argument('--script', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.allow_paid:
        parser.error('单节点付费测试必须获得授权并显式传 --allow-paid')
    asyncio.run(run(args.script, args.output))
