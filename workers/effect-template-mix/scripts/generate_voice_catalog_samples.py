"""One-time, resumable paid generation for the verified voice catalog."""
import asyncio
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

from effect_template_mix.api import ApiError, InternalApi
from effect_template_mix.packaging_media import pcm_wav
from effect_template_mix.packaging_provider import (
    PackagingError,
    PackagingProvider,
    PackagingTransientError,
    VoicePermissionError,
)


ROOT = Path(__file__).resolve().parents[3]
INTERNAL_ROOT = f"{InternalApi.ROOT}/voice-catalog-samples"


def load_root_env() -> None:
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip()
        if value[:1] == value[-1:] and value.startswith(("'", '"')):
            value = value[1:-1]
        if name:
            os.environ.setdefault(name, value)


def make_provider() -> PackagingProvider:
    key = os.environ.get("VOLC_TTS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("VOLC_TTS_API_KEY is not configured")
    return PackagingProvider(
        tts_key=key,
        speaker="",
        resource_id="seed-tts-2.0",
        access_key="",
        secret_key="",
        music_action="GenBGMForTime",
    )


def sample_text(target: dict[str, Any]) -> str:
    speaker = str(target.get("speaker", ""))
    if speaker.startswith("en_"):
        return "Hello, welcome to this voice preview."
    return "你好，欢迎试听当前音色。"


async def run() -> None:
    load_root_env()
    token = os.environ.get("EFFECT_TEMPLATE_MIX_WORKER_TOKEN", "").strip()
    if not token:
        raise RuntimeError("EFFECT_TEMPLATE_MIX_WORKER_TOKEN is not configured")
    base_url = os.environ.get("INTERNAL_API_BASE_URL", "http://127.0.0.1:3100/api").strip()
    api = InternalApi(base_url, token, 90)
    provider = make_provider()
    generated = 0
    skipped = 0
    try:
        targets = await api.request("GET", INTERNAL_ROOT)
        for target in targets:
            name = str(target["name"])
            version = str(target["version"])
            version_query = {"version": version}
            if target.get("sampleAvailable") or (
                target.get("attemptStatus")
                and target.get("attemptErrorCode") != "UPLOAD_FAILED"
            ):
                skipped += 1
                print(f"跳过已保存或已尝试的音色：{name}")
                continue
            voice_id = quote(str(target["id"]), safe="")
            claim = await api.request(
                "POST", f"{INTERNAL_ROOT}/{voice_id}/claim", params=version_query
            )
            if not claim.get("claimed"):
                skipped += 1
                print(f"跳过已被登记的音色：{name}")
                continue
            code = "SUBMISSION_UNKNOWN"
            try:
                pcm = await provider.voice(
                    sample_text(target),
                    speaker=str(target["speaker"]),
                    resource_id=str(target["resourceId"]),
                )
                wav, _ = pcm_wav(pcm)
                try:
                    await api.request(
                        "POST",
                        f"{INTERNAL_ROOT}/{voice_id}/audio",
                        params=version_query,
                        data={},
                        files={"file": ("sample.wav", wav, "audio/wav")},
                    )
                except ApiError:
                    try:
                        await api.request(
                            "POST",
                            f"{INTERNAL_ROOT}/{voice_id}/fail",
                            params={**version_query, "code": "UPLOAD_FAILED"},
                        )
                    finally:
                        print(f"样本上传失败，保留本次付费合成记录并停止批次：{name}")
                    break
                generated += 1
                print(f"试听样本已保存：{name}")
            except VoicePermissionError:
                code = "UNAUTHORIZED"
                try:
                    await api.request(
                        "POST",
                        f"{INTERNAL_ROOT}/{voice_id}/fail",
                        params={**version_query, "code": code},
                    )
                finally:
                    print(f"账号权限验证失败，停止批次：{name}")
                break
            except PackagingTransientError as exc:
                try:
                    await api.request(
                        "POST",
                        f"{INTERNAL_ROOT}/{voice_id}/fail",
                        params={**version_query, "code": "SUBMISSION_UNKNOWN"},
                    )
                finally:
                    print(f"提交结果不明，停止批次并保留防重标记：{name}（{type(exc).__name__}）")
                break
            except PackagingError as exc:
                code = "PROVIDER_REJECTED"
                try:
                    await api.request(
                        "POST",
                        f"{INTERNAL_ROOT}/{voice_id}/fail",
                        params={**version_query, "code": code},
                    )
                finally:
                    print(f"音色合成失败，停止批次：{name}（{type(exc).__name__}）")
                break
            except Exception as exc:
                # The paid request may have reached the provider; keep it fenced and never retry.
                print(f"提交结果不明，停止批次并保留防重标记：{name}（{type(exc).__name__}）")
                break
        print(f"本次保存 {generated} 个试听样本，跳过 {skipped} 个已有或已登记样本。")
    finally:
        await provider.close()
        await api.close()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except (ApiError, RuntimeError) as exc:
        raise SystemExit(str(exc)) from None
