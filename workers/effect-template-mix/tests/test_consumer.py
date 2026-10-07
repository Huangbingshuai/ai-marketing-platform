import asyncio
from unittest.mock import AsyncMock

import pytest

from effect_template_mix.api import ApiError, InternalApi
from effect_template_mix.consumer import Consumer, temporary_video_directory
from effect_template_mix.models import (
    Claim,
    ClassificationResult,
    ClassificationCheckpoint,
    Selection,
    Material,
    Runtime,
    SampledMaterial,
    SamplingCheckpoint,
    TrimCheckpoint,
    TrimOutput,
    Snapshot,
)
from effect_template_mix.provider import ArkProvider, ProviderError, TrimChoice
from effect_template_mix.reliability import (
    classification_chunks,
    classification_output_token_budget,
)


def material(index: int) -> Material:
    return Material(
        id=f"m{index}",
        code=f"V{index:03d}",
        name=f"片段 {index}",
        duration=15,
        promptId=f"p{index}",
        prompt=f"素材提示词 {index}",
        artifactId=f"a{index}",
        artifactKey=f"render-clip:m{index}",
        artifactRevision=1,
        contentHash="a" * 64,
        fileObjectId=f"f{index}",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [None, 503, 401, 403])
@pytest.mark.parametrize('redelivered', [False, True])
async def test_unclaimed_api_failure_preserves_delivery(monkeypatch, status, redelivered) -> None:
    api = AsyncMock(spec=InternalApi)
    api.claim.side_effect = ApiError('internal API unavailable', retryable=status in (None, 503), status_code=status)
    monkeypatch.setattr('effect_template_mix.consumer.asyncio.sleep', AsyncMock())
    consumer = Consumer('amqp://test', 'effect.template-mix.requested', api,
                        AsyncMock(spec=ArkProvider), 1000, 10, 16000, 8192, 1)
    message = AsyncMock()
    message.redelivered = redelivered
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'
    await consumer.handle(message)
    message.nack.assert_awaited_once_with(requeue=True)
    message.ack.assert_not_awaited()
    api.fail.assert_not_awaited()


def test_full_batch_coverage_requirement_is_frozen_and_old_snapshots_still_parse() -> None:
    source = {
        'schemaVersion': 1, 'template': {'slots': []}, 'draftRevision': 1,
        'targetVariantId': None, 'lockedBindings': [], 'promptArtifacts': [],
        'materials': [material(0).model_dump()],
    }
    assert Snapshot.model_validate(source).requireAllMaterials is False
    assert Snapshot.model_validate(source).replaceExistingVariants is False
    assert Snapshot.model_validate({**source, 'requireAllMaterials': True}).requireAllMaterials is True
    replacement = Snapshot.model_validate({**source, 'requireAllMaterials': True, 'replaceExistingVariants': True})
    assert replacement.replaceExistingVariants is True
    assert replacement.model_dump()['replaceExistingVariants'] is True


def test_classification_chunks_preserve_every_material_once() -> None:
    source = [material(index) for index in range(25)]

    batches = classification_chunks(
        source,
        configured_max_size=10,
        max_output_tokens=8_192,
        max_input_tokens=16_000,
    )

    assert all(1 <= len(batch) <= 4 for batch in batches)
    assert [item.id for batch in batches for item in batch] == [item.id for item in source]


@pytest.mark.asyncio
async def test_full_refill_classifies_the_entire_latest_pool_and_recomputes_trims(monkeypatch: pytest.MonkeyPatch) -> None:
    roles = ("HOOK", "PAIN_POINT", "PRODUCT", "SELLING_POINT", "TRANSFORMATION", "END")
    sources = [material(i) for i in range(7)]
    sources[0] = sources[0].model_copy(update={"artifactRevision": 2, "fileObjectId": "edited-file"})
    sources[-1] = sources[-1].model_copy(update={"artifactRevision": 9, "prompt": "新增后编辑的画面"})
    api = AsyncMock(spec=InternalApi)
    api.claim.return_value = Claim(terminal=False, attemptToken="lease", snapshot={
        "schemaVersion": 1, "template": {"id": "t", "slots": [
            {"id": f"s{i}", "role": role, "label": role, "duration": 4} for i, role in enumerate(roles)]},
        "draftRevision": 2, "targetVariantId": None, "lockedBindings": [], "promptArtifacts": [],
        "replaceExistingVariants": True, "requireAllMaterials": True,
        "materialRoleAssignments": {}, "manualMaterialRoles": {},
        "materials": [source.model_dump() for source in sources],
    }, checkpoint={})
    api.classify.return_value = [Selection(
        variantIndex=batch, slotId=f"s{i}", role=role, materialId=f"m{6 if batch == 1 and i == 0 else i}",
        matchScore=0.8, matchLevel="NORMAL", classificationReason="新归槽", duration=4,
    ) for batch in range(2) for i, role in enumerate(roles)]
    api.video.return_value = b"fake-video"
    api.checkpoint_classifications.return_value = ClassificationCheckpoint(classifications=[], progress=30)
    api.checkpoint_sampling.return_value = SamplingCheckpoint(materialIds=[])
    api.checkpoint_trims.return_value = TrimCheckpoint(trims=[], progress=90)
    provider = AsyncMock(spec=ArkProvider)

    async def classify(_slots, batch):
        return ClassificationResult.model_validate({"classifications": [
            {"materialId": source.id, "scores": {role: 0.8 for role in roles}, "reasons": {}}
            for source in batch]})

    provider.classify.side_effect = classify
    provider.trim.return_value = TrimChoice(trimStartSeconds=1, trimReason="重新选区")
    monkeypatch.setattr("effect_template_mix.consumer.sample_frames", AsyncMock(return_value=[(1.0, b"frame")]))
    consumer = Consumer("amqp://test", "effect.template-mix.requested", api, provider, 1000, 10, 16000, 8192, 1)
    message = AsyncMock()
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'
    await consumer.handle(message)
    classified = [source.id for call in provider.classify.await_args_list for source in call.args[1]]
    assert sorted(classified) == sorted(source.id for source in sources)
    assert len(classified) == len(set(classified))
    assert {row.materialId for row in api.classify.await_args.args[1]} == {source.id for source in sources}
    assert provider.trim.await_count == len(api.classify.return_value)
    api.complete.assert_awaited_once()
    api.fail.assert_not_awaited()
    message.ack.assert_awaited_once()


@pytest.mark.asyncio
async def test_append_recovery_keeps_distinct_trim_points_for_reused_clip() -> None:
    api = AsyncMock(spec=InternalApi)
    rows = [{"materialId": "m1", "scores": {role: int(role == "HOOK") for role in
        ("HOOK", "PAIN_POINT", "PRODUCT", "SELLING_POINT", "TRANSFORMATION", "END")}, "reasons": {}}]
    selections = [{"variantIndex": i, "slotId": "s", "role": "HOOK", "materialId": "m1",
        "matchScore": 1, "matchLevel": "NORMAL", "classificationReason": "动作", "duration": 4} for i in range(2)]
    trims = [{"variantIndex": i, "slotId": "s", "materialId": "m1", "trimStartSeconds": i + 1,
        "trimReason": "独立选区"} for i in range(2)]
    api.claim.return_value = Claim.model_validate({"terminal": False, "attemptToken": "lease", "snapshot": {
        "schemaVersion": 1, "template": {"id": "t", "slots": [{"id": "s", "role": "HOOK", "label": "片头", "duration": 4}]},
        "draftRevision": 1, "targetVariantId": None, "lockedBindings": [], "promptArtifacts": [],
        "materials": [material(1).model_dump()], "incremental": {"materialIds": ["m1"], "oldVariantIds": ["old"], "packageNewVariants": False},
    }, "checkpoint": {"classifications": rows, "selections": selections, "trims": trims}})
    provider = AsyncMock(spec=ArkProvider)
    consumer = Consumer("amqp://test", "effect.template-mix.requested", api, provider, 1000, 10, 16000, 8192, 1)
    message = AsyncMock()
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'
    await consumer.handle(message)
    provider.plan_incremental.assert_not_awaited()
    provider.trim.assert_not_awaited()
    assert [item.trimStartSeconds for item in api.complete.await_args.args[1]] == [1, 2]
    message.ack.assert_awaited_once()


@pytest.mark.asyncio
async def test_manual_role_skips_ai_classification_and_keeps_unassigned_materials_in_ai_batch() -> None:
    api = AsyncMock(spec=InternalApi)
    roles = ("HOOK", "PAIN_POINT", "PRODUCT", "SELLING_POINT", "TRANSFORMATION", "END")
    api.claim.return_value = Claim(
        terminal=False, attemptToken="lease",
        snapshot={
            "schemaVersion": 1,
            "template": {"id": "template", "slots": [
                {"id": "hook", "role": "HOOK", "label": "片头钩子", "duration": 4},
                {"id": "product", "role": "PRODUCT", "label": "产品展示", "duration": 4},
            ]},
            "draftRevision": 1, "targetVariantId": None, "lockedBindings": [],
            "manualMaterialRoles": {"m1": "HOOK"}, "materialRoleAssignments": {"m1": "HOOK"},
            "promptArtifacts": [], "materials": [material(1).model_dump(), material(2).model_dump()],
        },
        checkpoint={"trims": [
            {"slotId": "hook", "materialId": "m1", "trimStartSeconds": 0, "trimReason": "完整动作"},
            {"slotId": "product", "materialId": "m2", "trimStartSeconds": 0, "trimReason": "完整动作"},
        ]},
    )
    api.classify.return_value = [Selection.model_validate({
        "slotId": slot_id, "role": role, "materialId": material_id,
        "matchScore": 1, "matchLevel": "NORMAL", "classificationReason": "归槽", "duration": 4,
    }) for slot_id, role, material_id in (("hook", "HOOK", "m1"), ("product", "PRODUCT", "m2"))]
    provider = AsyncMock(spec=ArkProvider)
    provider.classify.return_value = ClassificationResult.model_validate({"classifications": [{
        "materialId": "m2", "scores": {role: int(role == "PRODUCT") for role in roles}, "reasons": {},
    }]})
    api.checkpoint_classifications.return_value = ClassificationCheckpoint(classifications=[], progress=30)
    consumer = Consumer("amqp://test", "effect.template-mix.requested", api, provider, 1000, 10, 16000, 8192, 1)
    message = AsyncMock()
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'
    await consumer.handle(message)
    provider.classify.assert_awaited_once()
    assert [item.id for item in provider.classify.await_args.args[1]] == ["m2"]
    rows = api.classify.await_args.args[1]
    assert rows[0].source == "MANUAL"
    assert rows[0].scores.HOOK == 1
    assert rows[0].reasons == {"HOOK": "用户手动归槽"}
    provider.trim.assert_not_awaited()
    api.complete.assert_awaited_once()


def test_cleanup_error_does_not_mask_retryable_provider_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    class Temporary:
        name = '/tmp/temporary-video-test'

        def cleanup(self) -> None:
            raise OSError(39, 'Directory not empty')

    monkeypatch.setattr('effect_template_mix.consumer.tempfile.TemporaryDirectory', lambda **_kwargs: Temporary())
    with pytest.raises(ProviderError) as caught:
        with temporary_video_directory():
            raise ProviderError('temporary', retryable=True)
    assert caught.value.retryable


def test_classification_chunks_split_large_prompt_by_input_budget() -> None:
    source = [
        material(index).model_copy(update={"prompt": "长提示词" * 2_000})
        for index in range(3)
    ]

    batches = classification_chunks(
        source,
        configured_max_size=10,
        max_output_tokens=8_192,
        max_input_tokens=8_000,
    )

    assert [len(batch) for batch in batches] == [1, 1, 1]
    assert classification_output_token_budget(batches[0]) == 1_205


@pytest.mark.asyncio
async def test_sampling_checkpoint_uses_the_run_lease_and_persists_frame_timestamps(monkeypatch: pytest.MonkeyPatch) -> None:
    api = InternalApi("http://test", "token", 1)
    sample = SampledMaterial(materialId="material-1", frameTimestampsSeconds=[0.5, 1.5])
    request = AsyncMock(return_value={"materialIds": ["material-1"], "samples": [sample.model_dump()]})
    monkeypatch.setattr(api, "request", request)
    runtime = Runtime(project_id="project-1", run_id="run-1", attempt_token="lease-1")

    result = await api.checkpoint_sampling(runtime, [sample])

    assert isinstance(result, SamplingCheckpoint)
    request.assert_awaited_once_with(
        "PUT",
        "internal/workers/effect-template-mix/runs/run-1/sampling/checkpoint",
        headers={"x-attempt-token": "lease-1"},
        json={"projectId": "project-1", "samples": [sample.model_dump()]},
    )
    await api.close()


@pytest.mark.asyncio
async def test_trim_only_refresh_skips_classification_and_retrims_only_the_fixed_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    api = AsyncMock(spec=InternalApi)
    selected = {
        "variantIndex": 0,
        "slotId": "slot-updated",
        "role": "PRODUCT",
        "materialId": "clip-updated",
        "matchScore": 0.8,
        "matchLevel": "NORMAL",
        "classificationReason": "保留原槽位素材归属",
        "duration": 4,
    }
    source = material(1).model_copy(update={
        "id": "clip-updated", "duration": 10, "promptId": "prompt-updated",
        "prompt": "新版产品展示画面", "artifactId": "clip-updated",
        "artifactKey": "render-clip:updated", "artifactRevision": 2,
    })
    snapshot = {
        "schemaVersion": 1,
        "template": {"id": "template", "name": "模板", "editVersion": 1,
            "slots": [{"id": "slot-updated", "role": "PRODUCT", "label": "产品展示", "duration": 4}]},
        "draftRevision": 4,
        "targetVariantId": "variant",
        "trimOnly": True,
        "lockedBindings": [],
        "promptArtifacts": [],
        "materials": [source.model_dump()],
    }
    api.claim.return_value = Claim(
        terminal=False,
        attemptToken="lease",
        snapshot=snapshot,
        checkpoint={"selections": [selected]},
    )
    api.video.return_value = b"fake-video"
    api.checkpoint_sampling.return_value = SamplingCheckpoint(
        materialIds=["clip-updated"],
        samples=[SampledMaterial(materialId="clip-updated", frameTimestampsSeconds=[1, 2])],
    )
    api.checkpoint_trims.return_value = TrimCheckpoint(
        trims=[TrimOutput(slotId="slot-updated", materialId="clip-updated", trimStartSeconds=2, trimReason="动作完整")],
        progress=90,
    )
    provider = AsyncMock(spec=ArkProvider)
    provider.trim.return_value = TrimChoice(trimStartSeconds=2, trimReason="动作完整")
    monkeypatch.setattr(
        "effect_template_mix.consumer.sample_frames",
        AsyncMock(return_value=[(1.0, b"frame-1"), (2.0, b"frame-2")]),
    )
    consumer = Consumer(
        "amqp://test", "effect.template-mix.requested", api, provider,
        1000, 10, 16000, 8192, 1,
    )
    message = AsyncMock()
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'

    await consumer.handle(message)

    provider.classify.assert_not_awaited()
    provider.trim.assert_awaited_once()
    assert api.video.await_count == 1
    assert api.video.await_args.args[1:] == ("clip-updated", 1000)
    api.complete.assert_awaited_once()
    assert len(api.complete.await_args.args[1]) == 1
    assert api.complete.await_args.args[1][0].slotId == "slot-updated"


@pytest.mark.asyncio
@pytest.mark.parametrize('recoverable', [False, True])
async def test_failed_lease_heartbeat_does_not_leave_completed_message_unacknowledged(
    monkeypatch: pytest.MonkeyPatch,
    recoverable: bool,
) -> None:
    api = AsyncMock(spec=InternalApi)
    selection = {
        "variantIndex": 0, "slotId": "slot-1", "role": "PRODUCT",
        "materialId": "m1", "matchScore": 0.8, "matchLevel": "NORMAL",
        "classificationReason": "已选素材", "duration": 4,
    }
    trim = {
        "variantIndex": 0, "slotId": "slot-1", "materialId": "m1",
        "trimStartSeconds": 1, "trimReason": "动作完整",
    }
    api.claim.return_value = Claim(
        terminal=False,
        attemptToken="lease",
        snapshot={
            "schemaVersion": 1,
            "template": {"id": "template", "name": "模板", "editVersion": 1,
                         "slots": [{"id": "slot-1", "role": "PRODUCT", "label": "产品展示", "duration": 4}]},
            "draftRevision": 4,
            "targetVariantId": "variant",
            "trimOnly": True,
            "lockedBindings": [],
            "promptArtifacts": [],
            "materials": [material(1).model_dump()],
        },
        checkpoint={"selections": [selection], "trims": [trim]},
    )
    original_sleep = asyncio.sleep
    recovered = asyncio.Event()
    heartbeat_calls = 0

    async def heartbeat_sleep(_seconds: float) -> None:
        if recoverable:
            await original_sleep(0)
            return
        raise ApiError("智能填充任务租约已失效", retryable=False, status_code=409)

    async def heartbeat_progress(*_args: object) -> None:
        nonlocal heartbeat_calls
        heartbeat_calls += 1
        if heartbeat_calls == 1:
            raise ApiError('internal API unavailable', retryable=True)
        recovered.set()

    async def finish_after_heartbeat(*_args: object) -> None:
        if recoverable:
            await asyncio.wait_for(recovered.wait(), 1)
        else:
            await original_sleep(0.01)

    monkeypatch.setattr("effect_template_mix.consumer.asyncio.sleep", heartbeat_sleep)
    if recoverable:
        api.progress.side_effect = heartbeat_progress
    api.complete.side_effect = finish_after_heartbeat
    consumer = Consumer(
        "amqp://test", "effect.template-mix.requested", api,
        AsyncMock(spec=ArkProvider), 1000, 10, 16000, 8192, 1,
    )
    message = AsyncMock()
    message.body = b'{"schemaVersion":1,"projectId":"project","runId":"run","requestId":"request"}'

    await consumer.handle(message)

    api.complete.assert_awaited_once()
    message.ack.assert_awaited_once()
    message.nack.assert_not_awaited()
    if recoverable:
        assert heartbeat_calls >= 2
