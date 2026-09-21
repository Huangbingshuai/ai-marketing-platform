"""Volcengine adapters. Protocol references are recorded in the packaging plan.

No automatic retry of paid submissions: an ambiguous result requires reconciliation.
"""
import base64
import hashlib
import hmac
import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import httpx


class PackagingError(RuntimeError):
    """Only sanitized, user-readable messages may cross the API boundary."""


def signed_headers(action: str, body: bytes, access_key: str, secret_key: str,
                   now: datetime | None = None) -> dict[str, str]:
    timestamp = (now or datetime.now(timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
    digest = hashlib.sha256(body).hexdigest()
    headers = {'content-type': 'application/json', 'host': 'open.volcengineapi.com',
               'x-content-sha256': digest, 'x-date': timestamp}
    names = ';'.join(sorted(headers))
    query = urlencode({'Action': action, 'Version': '2024-08-12'})
    canonical = '\n'.join(['POST', '/', query, ''.join(f'{k}:{headers[k]}\n' for k in sorted(headers)), names, digest])
    scope = f'{timestamp[:8]}/cn-beijing/imagination/request'
    message = '\n'.join(['HMAC-SHA256', timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = secret_key.encode()
    for part in (timestamp[:8], 'cn-beijing', 'imagination', 'request'):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, message.encode(), hashlib.sha256).hexdigest()
    headers['authorization'] = f'HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={names}, Signature={signature}'
    return headers


class PackagingProvider:
    def __init__(self, tts_key: str, speaker: str, resource_id: str, access_key: str,
                 secret_key: str, music_action: str, client: httpx.AsyncClient | None = None) -> None:
        self.tts_key, self.speaker, self.resource_id = tts_key, speaker, resource_id
        self.access_key, self.secret_key, self.music_action = access_key, secret_key, music_action
        self.client = client or httpx.AsyncClient(timeout=120, follow_redirects=False)

    def require_configuration(self) -> None:
        if not self.tts_key or not self.speaker:
            raise PackagingError('未配置豆包配音 API Key 或音色，包装未执行')
        if not self.access_key or not self.secret_key:
            raise PackagingError('未配置火山纯音乐服务 AK/SK，包装未执行')

    async def close(self) -> None:
        await self.client.aclose()

    async def voice(self, text: str) -> bytes:
        headers = {'X-Api-Key': self.tts_key, 'X-Api-Resource-Id': self.resource_id, 'X-Api-Request-Id': str(uuid4())}
        payload = {'user': {'uid': 'effect-template-mix'}, 'req_params': {'text': text, 'speaker': self.speaker,
                   'audio_params': {'format': 'pcm', 'sample_rate': 24000}}}
        chunks: list[bytes] = []
        size = 0
        complete = False
        async with self.client.stream('POST', 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
                                      headers=headers, json=payload) as response:
            if response.is_error:
                raise PackagingError('豆包配音请求失败，请检查服务权限和音色配置')
            async for line in response.aiter_lines():
                if not line.startswith('data:'):
                    continue
                row = json.loads(line[5:].strip())
                if row.get('code') == 20000000:
                    complete = True
                    break
                if row.get('code') != 0:
                    raise PackagingError('豆包配音合成失败')
                if row.get('data'):
                    chunk = base64.b64decode(row['data'], validate=True)
                    size += len(chunk)
                    if size > 24_000 * 2 * 120:
                        raise PackagingError('单句配音超过容量上限')
                    chunks.append(chunk)
        if not complete or not size or size % 2:
            raise PackagingError('配音流未完整结束，请重试本条口播')
        return b''.join(chunks)

    async def music_request(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        response = await self.client.post('https://open.volcengineapi.com/', params={'Action': action, 'Version': '2024-08-12'},
            headers=signed_headers(action, body, self.access_key, self.secret_key), content=body)
        if response.is_error:
            raise PackagingError('火山纯音乐请求失败，请核查服务权限或任务状态')
        value = response.json()
        if value.get('Code') != 0 or value.get('ResponseMetadata', {}).get('Error'):
            raise PackagingError('火山纯音乐服务返回失败')
        result = value.get('Result')
        if not isinstance(result, dict):
            raise PackagingError('火山纯音乐响应结构无效')
        return result

    async def submit_music(self, text: str, duration: float) -> str:
        result = await self.music_request(self.music_action, {'Text': text, 'Duration': max(30, min(120, round(duration))),
            'EnableInputRewrite': False, 'Version': 'v5.0'})
        task = result.get('TaskID')
        if not isinstance(task, str) or not task:
            raise PackagingError('音乐任务提交结果不明，请核查控制台；不会自动重复提交')
        return task

    async def query_music(self, task_id: str) -> str | None:
        result = await self.music_request('QuerySong', {'TaskID': task_id})
        if str(result.get('TaskID', task_id)) != task_id:
            raise PackagingError('音乐查询返回了其他任务')
        status = result.get('Status')
        if status in (0, 1):
            return None
        if status != 2:
            raise PackagingError('纯音乐生成失败，请重做本条音乐')
        song = result.get('SongDetail') or {}
        if str(song.get('Lyrics') or '').strip():
            raise PackagingError('纯音乐结果包含歌词，已拒绝使用')
        url = song.get('AudioUrl')
        if not isinstance(url, str):
            raise PackagingError('音乐结果缺少音频地址')
        parts = urlsplit(url)
        if parts.scheme != 'https' or not re.fullmatch(r'v(?:[1-9]|[1-4][0-9]|50)-default\.douyinvod\.com', parts.hostname or '') or parts.username or parts.port not in (None, 443):
            raise PackagingError('音乐下载地址不在官方允许范围')
        return url

    async def download_music(self, url: str) -> bytes:
        # Never send API credentials to the result CDN or follow a redirect to an arbitrary host.
        async with self.client.stream('GET', url) as response:
            if response.status_code != 200:
                raise PackagingError('音乐转存下载失败')
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > 100 * 1024 * 1024:
                    raise PackagingError('音乐文件超过容量上限')
                chunks.append(chunk)
        return b''.join(chunks)
