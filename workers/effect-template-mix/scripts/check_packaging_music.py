"""Single paid music submission with durable receipt; subsequent invocations only poll."""
import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path

from effect_template_mix.config import get_settings
from effect_template_mix.packaging_media import music_wav
from effect_template_mix.packaging_provider import PackagingError, PackagingProvider


async def run(script: Path, output: Path, allow_paid: bool) -> None:
    snapshot = json.load(sys.stdin)['snapshot']
    brief = json.loads(script.read_text(encoding='utf-8'))['musicBrief']
    output.mkdir(parents=True, exist_ok=True)
    receipt = output / 'receipt.json'
    fingerprint = hashlib.sha256(json.dumps([brief, snapshot['duration']]).encode()).hexdigest()
    state = json.loads(receipt.read_text()) if receipt.exists() else None
    if state and state['fingerprint'] != fingerprint:
        raise PackagingError('音乐输入已改变，禁止混用任务回执')
    if state and not state.get('taskId'):
        raise PackagingError('已有提交回执但结果不明，不再提交付费任务')
    if (output / 'music.wav').exists():
        print(json.dumps({'stage': 'MUSIC', 'status': 'ALREADY_SAVED'}))
        return
    if not state and not allow_paid:
        raise PackagingError('新音乐生成必须显式授权 --allow-paid')
    settings = get_settings()
    provider = PackagingProvider(settings.tts_api_key.get_secret_value(), settings.tts_speaker,
        settings.tts_resource_id, settings.music_access_key.get_secret_value(),
        settings.music_secret_key.get_secret_value(), settings.music_action)
    started = time.monotonic()
    try:
        provider.require_configuration()
        if not state:
            state = {'fingerprint': fingerprint, 'pending': True}
            with receipt.open('x', encoding='utf-8') as file:
                json.dump(state, file)
            task_id = await provider.submit_music(brief, snapshot['duration'])
            state.update({'taskId': task_id, 'pending': False})
            receipt.write_text(json.dumps(state), encoding='utf-8')
            print(json.dumps({'stage': 'MUSIC', 'status': 'SUBMITTED', 'taskId': task_id}), flush=True)
        async with asyncio.timeout(1800):
            while True:
                url = await provider.query_music(state['taskId'])
                if url:
                    break
                await asyncio.sleep(5)
        data = await music_wav(await provider.download_music(url), output, snapshot['duration'])
        (output / 'music.wav').write_bytes(data)
        summary = {'stage': 'MUSIC', 'status': 'PASSED', 'taskId': state['taskId'],
            'elapsedSeconds': round(time.monotonic() - started, 3),
            'duration': snapshot['duration'], 'sha256': hashlib.sha256(data).hexdigest()}
        (output / 'result.json').write_text(json.dumps(summary), encoding='utf-8')
        print(json.dumps(summary), flush=True)
    except Exception as exc:
        print(json.dumps({'stage': 'MUSIC', 'status': 'FAILED',
            'elapsedSeconds': round(time.monotonic() - started, 3),
            'error': str(exc) if isinstance(exc, PackagingError) else type(exc).__name__}, ensure_ascii=False), flush=True)
        raise SystemExit(1) from None
    finally:
        await provider.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-paid', action='store_true')
    parser.add_argument('--script', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(run(args.script, args.output, args.allow_paid))
