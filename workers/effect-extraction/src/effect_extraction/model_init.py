from __future__ import annotations

import os
from pathlib import Path

from docling.utils.model_downloader import download_models


def main() -> None:
    """Prefetch Docling models into the mounted default cache directory."""

    configured = os.getenv("DOCLING_ARTIFACTS_PATH")
    expected = Path(configured) if configured else Path.home() / ".cache" / "docling" / "models"
    download_models(output_dir=expected)
    if not expected.exists() or not any(expected.iterdir()):
        raise RuntimeError(f"Docling model download did not populate {expected}")


if __name__ == "__main__":
    main()
