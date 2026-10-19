from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Literal

from ai_runtime.http import InternalApiError, request, unwrap
from ai_runtime.responses import ProviderError
from ai_runtime.seedance import SeedanceTransport, ProviderError as VideoProviderError
from pydantic import BaseModel, ConfigDict, Field


class RenderSettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    capabilityKey: Literal['SEEDANCE_2_0', 'SEEDANCE_2_0_FAST', 'SEEDANCE_1_5_PRO', 'SEEDANCE_1_0']
    ratio: Literal['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']
    resolution: Literal['480p', '720p', '1080p', '4k']


class RenderReference(BaseModel):
    objectId: str
    name: str
    assetId: str
    version: int = Field(ge=1)
    storageKey: str
    mimeType: str
    sizeBytes: int = Field(gt=0, lt=30 * 1024 * 1024)
    sha256: str = Field(pattern=r'^[a-fA-F0-9]{64}$')


class RenderInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    settings: RenderSettings
    model: str = Field(min_length=1)
    clipId: str
    title: str
    seconds: int = Field(ge=2, le=30, strict=True)
    prompt: str = Field(min_length=1, max_length=50000)
    references: list[RenderReference] = Field(max_length=30)


def render_text(value: RenderInput) -> str:
    # Only the provider boundary gets numbered references. User text stays @name.
    names = {reference.name: index + 1 for index, reference in enumerate(value.references)}
    if not names:
        return value.prompt
    pattern = re.compile('@(' + '|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + ')')
    content = pattern.sub(lambda match: f'图片{names[match.group(1)]}', value.prompt)
    mapping = '；'.join(f'图片{index + 1}对应{reference.name}' for index, reference in enumerate(value.references))
    return (
        f'参考图对应关系：{mapping}。\n'
        '参考图是资产设定板，不是本镜的起始帧或完整画面。只取每张图所对应对象的外观与材质，'
        '人物图只参考人物，场景图只参考空间与光线，不从场景图额外带入正文未要求的商品、道具或人物。'
        '出镜对象、数量、摆放和出现时间严格以本镜正文为准；多视角是同一实体的不同角度，'
        '不能复制成多件实物，同一对象在正文中反复引用也不增加数量。'
        '成组对象仅呈现正文要求的组数和件数。不要将设定板、分栏或多视图直接放进视频，'
        '不追加正文未要求的产品展示或定版画面。\n'
        f'{content}'
    )


async def checkpoint(api: Any, stage: str, status: str, content: str, output: dict[str, Any] | None = None) -> None:
    await api.call('PUT', 'checkpoint', {'step': {'id': stage, 'status': status, 'title': {
        'SNAPSHOT': '渲染依据', 'PLAN': '准备参考图', 'GENERATE': '生成视频', 'REVIEW': '视频文件校验',
    }[stage], 'content': content}, **({'output': output} if output is not None else {})})


async def poster_for(video: bytes) -> bytes:
    with tempfile.TemporaryDirectory(prefix='customized-video-') as directory:
        source, poster = Path(directory) / 'video.mp4', Path(directory) / 'poster.jpg'
        await asyncio.to_thread(source.write_bytes, video)
        process = await asyncio.create_subprocess_exec('ffmpeg', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-ss', '0.1', '-i', str(source), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-an', str(poster), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(process.communicate(), timeout=60)
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            raise ValueError('video poster timed out') from None
        if process.returncode != 0 or not poster.is_file() or not 0 < poster.stat().st_size <= 2 * 1024 * 1024:
            raise ValueError('video cannot be decoded')
        return await asyncio.to_thread(poster.read_bytes)


async def upload(api: Any, video: bytes, poster: bytes) -> None:
    for attempt in range(5):
        try:
            response = await request(api.client, 'POST', 'video-output', headers={'x-attempt-token': api.token}, data={'projectId': api.project}, files={'video': ('video.mp4', video, 'video/mp4'), 'poster': ('poster.jpg', poster, 'image/jpeg')}, timeout=120)
            unwrap(response.json())
            return
        except InternalApiError as error:
            if not error.retryable or attempt == 4:
                raise
            await asyncio.sleep(min(8, 2 ** attempt))


async def run_video(api: Any, _provider: Any, claim: dict[str, Any]) -> None:
    value = RenderInput.model_validate(claim['input']['videoRender'])
    saved = dict(claim.get('output') or {})
    provider_id = saved.get('providerTaskId')
    if saved.get('createStarted') and not provider_id:
        raise ProviderError('视频请求结果未知，已停止自动重复提交', retryable=False)
    await checkpoint(api, 'SNAPSHOT', 'SUCCEEDED', f'{value.title} · {value.seconds}秒 · {value.settings.ratio} · {value.settings.resolution}\n本次实际引用：' + '、'.join(r.name for r in value.references))
    images: list[str] = []
    if not provider_id:
        for index, reference in enumerate(value.references):
            response = await request(api.client, 'GET', f'video-references/{index}', headers={'x-attempt-token': api.token}, params={'projectId': api.project}, timeout=60)
            data = response.content
            if len(data) != reference.sizeBytes or hashlib.sha256(data).hexdigest().lower() != reference.sha256.lower():
                raise ValueError('reference image integrity mismatch')
            images.append(f'data:{reference.mimeType};base64,' + base64.b64encode(data).decode('ascii'))
        if sum(len(image) for image in images) + len(value.prompt.encode('utf-8')) > 64 * 1024 * 1024 - 65536:
            raise ProviderError('参考图片总大小超过视频服务限制，请缩小图片后再生成', retryable=False)
    await checkpoint(api, 'PLAN', 'SUCCEEDED', '已校验本镜实际引用的固定图片版本' if images else '继续查询已提交视频任务' if provider_id else '本镜使用纯文字生成，不补充未引用图片')
    payload = {'model': value.model, 'content': [{'type': 'text', 'text': render_text(value)}, *[{'type': 'image_url', 'image_url': {'url': image}, 'role': 'reference_image'} for image in images]], 'duration': value.seconds, 'ratio': value.settings.ratio, 'resolution': value.settings.resolution, 'generate_audio': True, 'watermark': False}
    if not provider_id:
        await api.call('PUT', 'heartbeat')
        saved['createStarted'] = True
        await checkpoint(api, 'GENERATE', 'RUNNING', '正在提交本镜视频生成任务', saved)
    async def progress(percent: int, task_id: str | None) -> None:
        if task_id:
            saved['providerTaskId'] = task_id
        message = '视频已生成，正在下载原文件' if percent >= 92 else '视频服务已受理，正在生成本镜画面与声音'
        await checkpoint(api, 'GENERATE', 'RUNNING', message, saved)
    transport = SeedanceTransport(base_url=os.getenv('SEEDANCE_BASE_URL') or os.getenv('ARK_BASE_URL') or 'https://ark.cn-beijing.volces.com/api/v3', api_key=os.getenv('SEEDANCE_API_KEY') or os.environ['ARK_API_KEY'], timeout_seconds=max(60, float(os.getenv('CUSTOMIZED_VIDEO_RENDER_TIMEOUT_SECONDS', '900'))), poll_interval_seconds=max(1, float(os.getenv('SEEDANCE_POLL_INTERVAL_SECONDS', '8'))), create_qps=1, download_concurrency=1, max_download_bytes=512 * 1024 * 1024)
    try:
        output = await transport.render_request(payload, value.clipId + '.mp4', progress, provider_id)
        await checkpoint(api, 'GENERATE', 'SUCCEEDED', '本镜视频生成完成，已取得视频原文件', saved)
        await checkpoint(api, 'REVIEW', 'RUNNING', '正在解码封面并校验视频实际时长与尺寸')
        poster = await poster_for(output.content)
        await upload(api, output.content, poster)
    except VideoProviderError as error:
        if error.code == 'SEEDANCE_HTTP_429' and not saved.get('providerTaskId'):
            saved.update(createStarted=False, rateLimited=True)
            await checkpoint(api, 'GENERATE', 'RUNNING', '视频服务限流，等待有界自动重试', saved)
        elif not saved.get('providerTaskId') and re.fullmatch(r'SEEDANCE_HTTP_4\d\d', error.code):
            saved.update(createStarted=False, createRejected=True)
            await checkpoint(api, 'GENERATE', 'RUNNING', '视频服务未受理本次请求，请检查所选模型权限与配置', saved)
        raise ProviderError(str(error), retryable=error.retryable and not error.reset_provider_task) from error
    finally:
        await transport.aclose()
