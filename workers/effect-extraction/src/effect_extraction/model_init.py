from __future__ import annotations

import os
import subprocess
from pathlib import Path


def main() -> None:
    """Prefetch Docling models into the mounted default cache directory."""

    subprocess.run(["docling-tools", "models", "download"], check=True)
    configured = os.getenv("DOCLING_ARTIFACTS_PATH")
    expected = Path(configured) if configured else Path.home() / ".cache" / "docling" / "models"
    if not expected.exists() or not any(expected.iterdir()):
        raise RuntimeError(f"Docling model download did not populate {expected}")


if __name__ == "__main__":
    main()
