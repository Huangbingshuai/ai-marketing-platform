import json
from pathlib import Path
from typing import Any
import pytest
from customized_storyboard.models import Concepts, VideoScriptCreation
from customized_storyboard.pipeline import Pipeline
from customized_storyboard.video_script import PROFILES
from test_screenplay import concept
from test_story_only import Api


def test_video_script_cross_process_schemas_stay_in_sync() -> None:
    root = Path(__file__).resolve().parents[3] / 'packages/contracts/schemas'
    for name, model in [('customized-video-script-creation', VideoScriptCreation), ('customized-storyboard-concepts', Concepts)]:
        assert json.loads((root / f'{name}.schema.json').read_text(encoding='utf-8')) == model.model_json_schema()
    with pytest.raises(ValueError):
        VideoScriptCreation(videoType='UNKNOWN', referenceDurationSeconds=30, structureSections=[])  # type: ignore[arg-type]


class Provider:
    def __init__(self, video_type: str, severity: str | None = None) -> None:
        self.video_type, self.severity = video_type, severity
        self.calls: list[str] = []

    async def generate(self, stage: str, model: str, schema: Any, context: Any, instruction: str) -> Any:
        self.calls.append(stage)
        assert PROFILES[self.video_type] in instruction
        assert 'instructions' not in context['settings']
        if stage in {'STORY', 'REPAIR'}:
            story = {'title': '候车时刻', 'opening': '', 'development': '', 'ending': '', 'dialoguePlan': '',
                'beats': [{'id': 'P01', 'content': 'P01｜产品亮相\n\n深灰轮廓从明暗交界处缓缓显现，橙色端口成为画面的唯一亮色。', 'durationSeconds': 42}]}
            return schema.model_validate({'story': story, 'concept': context['concept']} if stage == 'REPAIR' else story)
        return schema.model_validate({'summary': '类型、创意、事实核对通过', 'findings': [
            {'severity': self.severity, 'category': 'STORY', 'shotIds': [], 'message': '视觉推进可加强', 'evidence': 'P01', 'suggestion': '展开亮相'}
        ] if stage == 'REVIEW' and self.severity else []})


@pytest.mark.parametrize('video_type', list(PROFILES))
@pytest.mark.parametrize('severity', [None, 'WARNING', 'ERROR'])
async def test_type_policy_soft_time_structure_and_independent_review(video_type: str, severity: str | None) -> None:
    api, provider = Api(), Provider(video_type, severity)
    p = Pipeline(api, provider, {'outputMode': 'STORY_ONLY', 'storyFormat': 'VIDEO_SCRIPT_V2', 'brief': {},
        'settings': {'videoType': video_type, 'targetDurationSeconds': 30, 'structureMode': 'CUSTOM', 'structureSections': ['产品亮相'], 'instructions': '旧的创作要求'},
        'existingConcepts': [], 'models': {'creative': 'controlled', 'detail': 'controlled'}}, [], [])  # type: ignore[arg-type]
    c = concept()
    await p.script(c, Concepts(concepts=[c]))
    script = api.calls[-1][1]['script']
    assert script['story']['beats'][0]['durationSeconds'] == 42
    assert script['creation'] == {'videoType': video_type, 'referenceDurationSeconds': 30, 'structureSections': ['产品亮相']}
    assert provider.calls == (['STORY', 'REVIEW', 'REPAIR', 'RECHECK'] if severity == 'ERROR' else ['STORY', 'REVIEW'])
    assert script['story']['content'].startswith('P01｜产品亮相')


async def test_wrong_structure_correction_is_bounded_and_cannot_publish() -> None:
    api, provider = Api(), Provider('BRAND_AD')
    p = Pipeline(api, provider, {'outputMode': 'STORY_ONLY', 'storyFormat': 'VIDEO_SCRIPT_V2', 'brief': {},
        'settings': {'videoType': 'BRAND_AD', 'targetDurationSeconds': 30, 'structureSections': ['主题回扣']},
        'existingConcepts': [], 'models': {'creative': 'controlled', 'detail': 'controlled'}}, [], [])  # type: ignore[arg-type]
    c = concept()
    with pytest.raises(ValueError, match='correction exhausted'):
        await p.script(c, Concepts(concepts=[c]))
    assert provider.calls == ['STORY', 'STORY']
    assert not any(path == 'scripts' for path, _ in api.calls)
