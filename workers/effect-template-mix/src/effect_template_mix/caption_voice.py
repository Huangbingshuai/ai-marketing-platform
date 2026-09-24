import asyncio
import logging
from typing import Any, Literal
from uuid import UUID

from aio_pika.abc import AbstractIncomingMessage
from pydantic import BaseModel, ConfigDict

from .api import ApiError, InternalApi
from .packaging_media import pcm_wav, trim_leading_silence
from .packaging_provider import PackagingProvider

LOGGER = logging.getLogger(__name__)


class CaptionVoiceProfile(BaseModel):
    # Only the two provider fields are read; the rest of the frozen profile is the API's business.
    model_config = ConfigDict(extra='ignore')
    speaker: str
    resourceId: str


class CaptionVoiceMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schemaVersion: Literal[2]
    taskType: Literal['CAPTION_VOICE']
    projectId: UUID
    runId: UUID
    itemId: UUID
    captionId: str
    text: str
    profile: CaptionVoiceProfile
    requestId: UUID


class CaptionVoiceHandler:
    """Speak one subtitle's text on demand, outside any packaging run.

    There is no lease, claim or fence here: the editor asked for this by hand, the API writes the
    result back keyed by caption, and a crash simply means the user clicks again. That is the whole
    trade-off — see 决策 3 in `docs/workflows/effect/plans/2026-09-24-精修工作台字幕生成口播.md`.
    """

    def __init__(self, api: InternalApi, provider: PackagingProvider, requests: asyncio.Semaphore) -> None:
        self.api, self.provider, self.requests = api, provider, requests
        self.single_voice = asyncio.Semaphore(1)

    async def handle(self, message: AbstractIncomingMessage, envelope: dict[str, Any]) -> None:
        try:
            request = CaptionVoiceMessage.model_validate(envelope)
        except ValueError:
            await message.ack()
            return
        async with self.single_voice:
            await self.execute(message, request)

    async def execute(self, message: AbstractIncomingMessage, request: CaptionVoiceMessage) -> None:
        root = f'{self.api.ROOT}/caption-voices/{request.runId}/items/{request.itemId}'
        body = {'projectId': str(request.projectId), 'captionId': request.captionId}
        try:
            self.provider.require_tts_configuration()
            async with self.requests, asyncio.timeout(90):
                pcm = await self.provider.voice(request.text, speaker=request.profile.speaker,
                    resource_id=request.profile.resourceId)
            # The API aligns this clip's start on the caption, so the engine's lead-in silence would
            # read as the narration lagging the subtitle it was generated from. The pipeline's own
            # narration lines keep their silence: their start is a slot boundary, not a subtitle's.
            wav, _ = pcm_wav(trim_leading_silence(pcm))
            # The API keys this write by caption and ignores bytes it already has, so retrying the
            # same upload is safe; it never re-synthesizes for the retry.
            for attempt in range(2):
                try:
                    await self.api.request('POST', f'{root}/audio', data=body,
                        files={'file': ('caption-voice.wav', wav, 'audio/wav')})
                    break
                except ApiError as exc:
                    if not exc.retryable or attempt:
                        raise
        except ApiError as exc:
            LOGGER.warning('caption voice rejected error=%s', type(exc).__name__)
            # A 4xx means the request itself is no longer valid — the caption is gone or the
            # packaging was reopened — and redelivering it would only pay for a second synthesis.
            await message.nack(requeue=exc.retryable and not message.redelivered)
            return
        except Exception as exc:
            LOGGER.warning('caption voice interrupted error=%s', type(exc).__name__)
            await message.nack(requeue=not message.redelivered)
            return
        await message.ack()
