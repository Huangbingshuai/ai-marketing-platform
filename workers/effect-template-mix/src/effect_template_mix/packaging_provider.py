"""Volcengine adapters. Protocol references are recorded in the packaging plan.

No automatic retry of paid submissions: an ambiguous result requires reconciliation.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import httpx

LOGGER = logging.getLogger(__name__)


class PackagingError(RuntimeError):
    """Only sanitized, user-readable messages may cross the API boundary."""


class MusicRateLimited(PackagingError):
    """An explicit rejection without a TaskID, not an ambiguous paid submission."""


class PackagingTransientError(PackagingError):
    """A recoverable request failure; never overrides ambiguous music-submit protection."""


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
                 secret_key: str, music_action: str, client: httpx.AsyncClient | None = None,
                 music_min_interval: float = 1.1) -> None:
        self.tts_key, self.speaker, self.resource_id = tts_key, speaker, resource_id
        self.access_key, self.secret_key, self.music_action = access_key, secret_key, music_action
        self.client = client or httpx.AsyncClient(timeout=120, follow_redirects=False)
        # One shared adapter serves all item tasks. Space submit AND query starts;
        # an item semaphore alone does not prevent four simultaneous API requests.
        self.music_min_interval = max(0, music_min_interval)
        self._music_lock = asyncio.Lock()
        self._music_next_request = 0.0

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
                if response.status_code == 429 or response.status_code >= 500:
                    raise PackagingTransientError('豆包配音暂时限流或不可用，正在自动恢复')
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
            raise PackagingTransientError('配音流未完整结束，正在自动恢复')
        return b''.join(chunks)

    async def music_request(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        async with self._music_lock:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(max(0, self._music_next_request - loop.time()))
            self._music_next_request = loop.time() + self.music_min_interval
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        response = await self.client.post('https://open.volcengineapi.com/', params={'Action': action, 'Version': '2024-08-12'},
            headers=signed_headers(action, body, self.access_key, self.secret_key), content=body)
        if response.is_error:
            if action == 'QuerySong' and (response.status_code == 429 or response.status_code >= 500):
                raise PackagingTransientError('音乐查询暂时不可用，保留原任务自动恢复')
            raise PackagingError('火山纯音乐请求失败，请核查服务权限或任务状态')
        value = response.json()
        metadata = value.get('ResponseMetadata') or {}
        error = metadata.get('Error') or {}
        if value.get('Code') != 0 or error:
            # Do not expose supplier response text, signed URLs or credentials.
            def safe_code(raw: Any) -> str:
                text = str(raw or '')
                return text if re.fullmatch(r'[a-zA-Z0-9_.:-]{0,160}', text) else 'redacted'
            LOGGER.warning('packaging music rejected action=%s code=%s error_code=%s request_id=%s',
                action, safe_code(value.get('Code')), safe_code(error.get('Code')), safe_code(metadata.get('RequestId')))
            result = value.get('Result')
            if (value.get('Code') == 200023 and error.get('Code') == 'APIOutOfQps'
                    and (result is None or isinstance(result, dict) and not result.get('TaskID'))):
                raise MusicRateLimited('火山音乐请求被限流拒绝，已保留成功步骤，可恢复未完成项')
            if value.get('Code') == 200028 or error.get('Code') == 'APINoSource':
                raise PackagingError('火山音乐账号未找到可用服务资源（200028/APINoSource），请核查 AK 所属账号、音乐服务开通和计费模式')
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
                if response.status_code == 429 or response.status_code >= 500:
                    raise PackagingTransientError('音乐下载暂时不可用，保留原任务自动恢复')
                raise PackagingError('音乐转存下载失败')
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > 100 * 1024 * 1024:
                    raise PackagingError('音乐文件超过容量上限')
                chunks.append(chunk)
        return b''.join(chunks)
