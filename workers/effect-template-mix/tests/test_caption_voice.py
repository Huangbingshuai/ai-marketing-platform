"""The caption narration is the one clip aligned on another clip's start, so its lead-in is trimmed."""
import struct

from effect_template_mix.packaging_media import pcm_wav, trim_leading_silence
from test_voice_library import caption_harness

RATE = 24000
# A ±16016 square wave: RMS .489, far above the noise floor the trimmer has to reject.
SPEECH_SAMPLE = struct.pack('<h', 16016) + struct.pack('<h', -16016)


def silence(seconds: float) -> bytes:
    return b'\x00\x00' * round(RATE * seconds)


def speech(seconds: float) -> bytes:
    return SPEECH_SAMPLE * round(RATE * seconds / 2)


def test_trim_leading_silence_keeps_only_the_pre_roll() -> None:
    # The live sample this was measured on: .68s of noise floor, then the line.
    result = trim_leading_silence(silence(.68) + speech(1))

    assert result == silence(.08) + speech(1)


def test_trim_leading_silence_leaves_the_tail_alone() -> None:
    result = trim_leading_silence(silence(.1) + speech(1) + silence(.3))

    assert result == silence(.08) + speech(1) + silence(.3)


def test_trim_leading_silence_returns_an_all_silent_line_unchanged() -> None:
    pcm = silence(1)

    assert trim_leading_silence(pcm) is pcm


def test_trim_leading_silence_returns_a_line_that_starts_immediately_unchanged() -> None:
    pcm = speech(1)

    assert trim_leading_silence(pcm) is pcm


def test_trim_leading_silence_ignores_input_too_short_to_score() -> None:
    assert trim_leading_silence(b'') == b''
    assert trim_leading_silence(b'\x01') == b'\x01'


async def test_caption_narration_uploads_the_trimmed_take() -> None:
    api, provider, message, envelope, handler = caption_harness()
    provider.voice.return_value = silence(.68) + speech(1)

    await handler.handle(message, envelope)

    uploaded = api.request.call_args_list[-1].kwargs['files']['file'][1]
    wav, duration = pcm_wav(silence(.08) + speech(1))
    assert uploaded == wav and abs(duration - 1.08) < 1e-6
    message.ack.assert_awaited_once()


async def test_caption_narration_never_trims_a_line_into_silence() -> None:
    # A provider that returns nothing but the noise floor must still upload what it got.
    api, provider, message, envelope, handler = caption_harness()
    provider.voice.return_value = silence(.5)

    await handler.handle(message, envelope)

    wav, _ = pcm_wav(silence(.5))
    assert api.request.call_args_list[-1].kwargs['files']['file'][1] == wav
