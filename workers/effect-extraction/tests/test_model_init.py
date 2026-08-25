from pathlib import Path

from pytest import MonkeyPatch

from effect_extraction import model_init


def test_model_init_downloads_into_configured_artifacts_path(
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    artifacts_path = tmp_path / "docling-models"

    def fake_download_models(*, output_dir: Path) -> None:
        (output_dir / "layout-model").mkdir(parents=True)

    monkeypatch.setenv("DOCLING_ARTIFACTS_PATH", str(artifacts_path))
    monkeypatch.setattr(model_init, "download_models", fake_download_models)

    model_init.main()

    assert (artifacts_path / "layout-model").is_dir()
