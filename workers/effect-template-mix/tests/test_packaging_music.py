import io
import json
import shutil
import wave
from unittest.mock import AsyncMock

import pytest

from effect_template_mix.packaging import plan_script
from effect_template_mix.packaging_media import ffmpeg, music_wav
from effect_template_mix.packaging_music import film_music_context
from test_packaging import plan_result, script_snapshot


def test_whole_film_music_direction_is_stable_and_diverse_between_items():
    snapshot = script_snapshot()
    directions = [film_music_context(f'packaging-item-{i}', snapshot, []) for i in range(44)]
    assert directions[0] == film_music_context('packaging-item-0', snapshot, [])
    profiles = [row['creativeReference'] for row in directions]
    assert len({json.dumps(profile, sort_keys=True) for profile in profiles}) == 44
    assert len({profile['style'] for profile in profiles}) == 8
    assert len({profile['texture'] for profile in profiles}) >= 7
    assert len({profile['groove'] for profile in profiles}) == 6


async def test_music_planning_uses_full_film_even_when_only_one_narration_slot_is_missing():
    snapshot = script_snapshot()
    full = {**snapshot, 'duration': 30, 'clips': [
        {'slotId': 'last', 'start': 22, 'duration': 8},
        *snapshot['clips'],
    ]}
    vision = [{'slotId': 'last', 'description': '结束画面'}, {'slotId': 's1', 'description': '开场画面'}]
    ark = AsyncMock()
    ark.structured.return_value = plan_result()
    await plan_script(ark, snapshot, vision, AsyncMock(), story_snapshot=full, music_identity='immutable-item')
    context = json.loads(ark.structured.call_args.args[0][0]['text'])
    film = context['wholeFilmMusic']
    assert film['duration'] == 30
    assert film['pictureSequence'] == [
        {'start': 0, 'duration': 10, 'picture': '开场画面'},
        {'start': 22, 'duration': 8, 'picture': '结束画面'},
    ]
    assert all('slotId' not in shot and 'role' not in shot for shot in film['pictureSequence'])
    assert any('一首连续纯器乐' in rule and '转场' in rule for rule in context['rules'])
    assert any('不输出分镜配乐清单' in rule for rule in context['rules'])
    assert any('差异化编曲参考' in rule for rule in context['rules'])


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg not installed')
async def test_music_transcode_keeps_stereo_detail_and_does_not_bake_timeline_fade(tmp_path):
    source = tmp_path / 'stereo.wav'
    await ffmpeg('-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*317*t)|0.15*sin(2*PI*853*t):s=48000:d=2',
                 '-c:a', 'pcm_s16le', '-y', str(source))
    result = await music_wav(source.read_bytes(), tmp_path, 1.5)
    with wave.open(io.BytesIO(result)) as sound:
        assert sound.getnchannels() == 2 and sound.getframerate() == 48000
        assert sound.getnframes() / sound.getframerate() == pytest.approx(1.5, abs=.001)
        raw = sound.readframes(sound.getnframes())
    import array
    samples = array.array('h', raw)
    left, right = samples[::2], samples[1::2]
    assert left != right
    def rms(values):
        return (sum(value * value for value in values) / len(values)) ** .5
    # No second baked fade-out; timeline preview/export own fade automation.
    assert rms(left[-4800:]) / rms(left[24000:28800]) == pytest.approx(1, abs=.03)
