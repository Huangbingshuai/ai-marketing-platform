import asyncio
import logging
from contextlib import suppress
from typing import Any, Literal
from uuid import UUID

import httpx
from aio_pika.abc import AbstractIncomingMessage
from pydantic import BaseModel, ConfigDict

from .api import ApiError, InternalApi
from .packaging_media import pcm_wav
from .packaging_provider import PackagingError, PackagingProvider, PackagingTransientError, VoicePermissionError

LOGGER = logging.getLogger(__name__)


class VoicePreviewMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schemaVersion: Literal[2]
    taskType: Literal['VOICE_PREVIEW']
    projectId: UUID
    runId: UUID
    requestId: UUID


class VoicePreviewHandler:
    def __init__(self, api: InternalApi, provider: PackagingProvider, requests: asyncio.Semaphore) -> None:
        self.api, self.provider, self.requests = api, provider, requests
        self.single_preview = asyncio.Semaphore(1)

    async def handle(self, message: AbstractIncomingMessage, envelope: dict[str, Any]) -> None:
        try:
            request = VoicePreviewMessage.model_validate(envelope)
        except ValueError:
            await message.ack()
            return
        async with self.single_preview:
            await self.execute(message, request)

    async def execute(self, message: AbstractIncomingMessage, request: VoicePreviewMessage) -> None:
        root = f'{self.api.ROOT}/voice-previews/{request.runId}'
        body = {'projectId': str(request.projectId)}
        beat: asyncio.Task[None] | None = None
        task: asyncio.Task[None] | None = None
        try:
            claim = await self.api.request('POST', f'{root}/claim', json=body)
            if claim['terminal']:
                await message.ack()
                return
            headers = {'x-attempt-token': claim['attemptToken']}

            async def heartbeat() -> None:
                while True:
                    await asyncio.sleep(20)
                    await self.api.request('PUT', f'{root}/heartbeat', json=body, headers=headers)

            async def generate() -> None:
                snapshot = claim['snapshot']
                code = 'SUBMISSION_UNKNOWN'
                try:
                    self.provider.require_tts_configuration()
                    async with self.requests:
                        # Persist a fence BEFORE the paid call. A lost response does not retry synthesis.
                        await self.api.request('POST', f'{root}/submit', json=body, headers=headers)
                        async with asyncio.timeout(90):
                            pcm = await self.provider.voice(snapshot['sampleText'], speaker=snapshot['profile']['speaker'],
                                resource_id=snapshot['profile']['resourceId'])
                    wav, _ = pcm_wav(pcm)
                    # Retrying the same bytes is safe; upload atomically binds the file and completes.
                    for attempt in range(2):
                        try:
                            await self.api.request('POST', f'{root}/audio', headers=headers, data=body,
                                files={'file': ('preview.wav', wav, 'audio/wav')})
                            return
                        except ApiError as exc:
                            if not exc.retryable or attempt:
                                raise
                except VoicePermissionError:
                    code = 'UNAUTHORIZED'
                except ApiError:
                    raise  # Cancellation / lease loss must never write a new result.
                except (httpx.TransportError, TimeoutError, PackagingTransientError):
                    code = 'SUBMISSION_UNKNOWN'
                except PackagingError:
                    code = 'PROVIDER_REJECTED'
                except (ValueError, KeyError):
                    code = 'INVALID_AUDIO'
                await self.api.request('POST', f'{root}/fail', headers=headers, json={**body, 'code': code})

            beat, task = asyncio.create_task(heartbeat()), asyncio.create_task(generate())
            done, _ = await asyncio.wait([beat, task], return_when=asyncio.FIRST_COMPLETED)
            for completed in done:
                completed.result()
            await message.ack()
        except Exception as exc:
            LOGGER.warning('voice preview interrupted error=%s', type(exc).__name__)
            await message.nack(requeue=not message.redelivered)
        finally:
            for pending in (task, beat):
                if pending:
                    pending.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await pending
